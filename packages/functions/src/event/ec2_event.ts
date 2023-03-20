import { DynamoDB, EC2 } from "aws-sdk";
import { Table } from "sst/node/table";
import { EventTypes } from "sst/bus";
import { EventBridgeEvent } from "aws-lambda";
import { DocumentClient } from "aws-sdk/lib/dynamodb/document_client";
import { ms } from "../helper/time-helper";
import { ResponseHelper } from "../helper/response";

const ec2 = new EC2();
const dynamoDb = new DynamoDB.DocumentClient();

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
  let params2: DynamoDB.BatchWriteItemInput = {
    RequestItems: { [Table.EC2_Status.tableName]: [] }
  };

  for (let id of idList) {
    params2.RequestItems[Table.EC2_Status.tableName].push({
      PutRequest: {
        Item: {
          InstanceId: id,
          Reboot: 1,
          RebootAt: ms()
        }
      }
    });
  }

  // Call DynamoDB to add the item to the table
  await dynamoDb.batchWrite(params2).promise();
  // return ResponseHelper.responseOK(stopRes);
  // return ResponseHelper.responseOK();
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
