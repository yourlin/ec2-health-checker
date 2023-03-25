import { DynamoDB, EC2, CloudWatch } from "aws-sdk";
import { Table } from "sst/node/table";
import { EventTypes } from "sst/bus";
import { EventBridgeEvent } from "aws-lambda";
import { DocumentClient } from "aws-sdk/lib/dynamodb/document_client";
import { ms } from "../helper/time-helper";
import { GetMetricDataInput } from "aws-sdk/clients/cloudwatch";
import { MAX_REBOOT_INSTANCE_NUM } from "../config";

const ec2 = new EC2();
const dynamoDb = new DynamoDB.DocumentClient();
const cloudwatch = new CloudWatch();

async function shutdownEC2(instanceId: string) {
  //停机前检查有多少台机器正在重启中
  const getParams = {
    TableName: Table.EC2_Status.tableName,
    ExpressionAttributeNames: {
      "#II": "InstanceId",
      "#RA": "RebootAt"
    },
    ExpressionAttributeValues: {
      ":reboot": {
        N: 1
      }
    },
    FilterExpression: "Reboot = :reboot",
    ProjectionExpression: "#II, #RA"
  };
  const results = await dynamoDb.scan(getParams).promise();

  // 如果已经有2个在重启，则不重启
  if (results.Items.length >= MAX_REBOOT_INSTANCE_NUM) {
    return;
  }

  const idList = [instanceId];
  const stopParams: EC2.StopInstancesRequest = {
    InstanceIds: idList,
    Force: true
  };

  let stopResult = ec2.stopInstances(stopParams, (err, data) => {
    err ? console.error(err) : console.log(data);
  });

  let stopRes = await stopResult.promise();
  // 停机成功后需要，记录一条信息表示这个实例是需要手动重启的，再关机检查event中，会判断是否再次启动
  const now = new Date();
  let putParams: DynamoDB.Types.UpdateItemInput = {
    TableName: Table.EC2_Status.tableName,
    Key: {
      InstanceId: instanceId
    },
    UpdateExpression: "SET Reboot = :reboot, RebootAt = :ms", //, TTL = :ttl
    ExpressionAttributeValues: {
      // Increase the count
      ":reboot": 1,
      ":ms": ms()
      // ":ttl": (new Date(now.getTime() + 10 * 60 * 1000)).getTime()
    }
  };

  // Call DynamoDB to add the item to the table
  await dynamoDb.update(putParams).promise();
}

export async function abnormalReceive(event: EventBridgeEvent<any, any>) {
  const msg = JSON.parse(event.Records[0].Sns.Message);
  const instanceId = msg.Trigger.Dimensions[0].value;
  const params = {
    TableName: Table.EC2_Status.tableName,
    Item: {
      InstanceId: instanceId,
      AlarmAt: ms()
    }
  };
  let res = await dynamoDb.put(params).promise();
  console.log(`检测到实例异常状态: ${instanceId}`);
  await shutdownEC2(instanceId);
  return;
}

export async function stopEventReceive(event: EventBridgeEvent<any, any>) {
  console.log("EC2 停止事件");
  // DDB检查是否是主动停止的EC2实例，然后执行启动
  const params: DocumentClient.GetItemInput = {
    TableName: Table.EC2_Status.tableName,
    Key: {
      InstanceId: event.detail["instance-id"]
    }
  };
  const resGetInstanceInfo = await dynamoDb.get(params).promise();
  // 如果不是通过API关机的，直接返回
  if (1 != resGetInstanceInfo.Item?.Reboot) {
    console.log("非强制关机");
    return {};
  }

  // 否则则重新启动这个实例
  let startParams: EC2.StartInstancesRequest;
  startParams = {
    InstanceIds: [event.detail["instance-id"]]
  };
  let startResult = ec2.startInstances(startParams, (err, data) => {
    if (err) {
      console.error(err);
    }
  });
  let startRes = await startResult.promise();
  console.log(`EC2：${event.detail["instance-id"]} 已经重启`);

  //启动EC2后，删除异常记录
  await dynamoDb
    .delete({
      TableName: Table.EC2_Status.tableName,
      Key: {
        InstanceId: event.detail["instance-id"]
      }
    })
    .promise();
  return {};
}

export async function ec2ScheduleCheck(event: EventBridgeEvent<any, any>) {
  const maxDataPoints = 3;
  // 查询EC2 instance 列表，可能存在翻页，获取所有id后调用异步健康检查
  let instanceIDList = [];
  let params = {
    Filters: [
      {
        Name: "tag:env",
        Values: [
          "prod"
        ]
      },
      {
        Name: "instance-state-name",
        Values: [
          "running"
        ]
      }
    ],
    NextToken: ""
    // MaxResults: 5 // 每页大小
  };
  let res = await ec2.describeInstances(params).promise(); // 只检查正在运行中的实例
  while (res.Reservations?.length !== 0) {
    for (let instance of res.Reservations) {
      for (let ins of instance.Instances) {
        instanceIDList.push(ins.InstanceId);
      }
    }

    if ("NextToken" in res) {
      params.NextToken = res.NextToken;
    } else {
      break;
    }
    res = await ec2.describeInstances(params).promise();
  }

  let cpuMetricsJobs: Promise<any>[] = [];
  for (let instanceId of instanceIDList) {
    const now = new Date();
    const metricsParams: GetMetricDataInput = {
      MetricDataQueries: [{
        Id: `q1`,
        Expression: `SELECT AVG(CPUUtilization) FROM SCHEMA("AWS/EC2", InstanceId) WHERE InstanceId = '${instanceId}'`,
        Period: 300,
        Label: "Instance CPU Utilization"
      }],
      StartTime: new Date(now.getTime() - 16 * 60 * 1000), //相对时间16分钟
      EndTime: now,
      MaxDatapoints: maxDataPoints
    };
    cpuMetricsJobs.push(cloudwatch.getMetricData(metricsParams).promise());
  }

  let statusMetricsJobs: Promise<any>[] = [];
  for (let instanceId of instanceIDList) {
    const now = new Date();
    const metricsParams: GetMetricDataInput = {
      MetricDataQueries: [{
        Id: "q2",
        Expression: `SELECT MAX(StatusCheckFailed) FROM SCHEMA("AWS/EC2", InstanceId) WHERE InstanceId = '${instanceId}'`,
        Period: 300,
        Label: "Instance Status Check Failed"
      }],
      StartTime: new Date(now.getTime() - 16 * 60 * 1000), //相对时间16分钟
      EndTime: now,
      MaxDatapoints: maxDataPoints
    };
    statusMetricsJobs.push(cloudwatch.getMetricData(metricsParams).promise());
  }

  const cpuResults = await Promise.all(cpuMetricsJobs);
  const statusResults = await Promise.all(statusMetricsJobs);
  let abnormalCount = 0;
  for (let i = 0; i < cpuResults.length; i++) {
    const cpuResult = cpuResults[i];
    const statusResult = statusResults[i];

    // 数据缺失，且健康检查失败
    if (cpuResult.MetricDataResults[0].Values.length < maxDataPoints
      && statusResult.MetricDataResults[0].Values.at(-1) === 1) {
      console.log(`Instance ID: ${instanceIDList[i]}，检查冷却时间，重启`);
      await shutdownEC2(instanceIDList[i]);
      abnormalCount++;

      if (abnormalCount >= MAX_REBOOT_INSTANCE_NUM) {
        break;
      }
    }
  }

  // todo解析结果判断是否重启
}