import { DynamoDB, EC2 } from "aws-sdk";
import { Table } from "sst/node/table";
import { APIGatewayProxyHandlerV2 } from "aws-lambda";
import { ResponseHelper } from "../helper/response";
import { WriteRequests } from "aws-sdk/clients/dynamodb";
import { ms } from "../helper/time-helper";

const dynamoDb = new DynamoDB.DocumentClient();
const ec2 = new EC2();
export const abnormal: APIGatewayProxyHandlerV2 = async () => {
  const getParams = {
    // Get the table name from the environment variable
    TableName: Table.EC2_Status.tableName,
  };
  const results = await dynamoDb.scan(getParams).promise();
  return ResponseHelper.responseOK(results);
};

export const reboot: APIGatewayProxyHandlerV2 = async (event) => {
  const params = {
    InstanceIds: event.pathParameters?.id?.split(";") ?? [],
  };

  if (params.InstanceIds === undefined) {
    return ResponseHelper.responseParameterError();
  }

  let result = ec2.rebootInstances(params, (err, data) => {
    if (err) console.error(err);

    console.log(data);
  });

  let data = await result.promise();
  return ResponseHelper.responseOK(data);
};

export const forceStopAndStart: APIGatewayProxyHandlerV2 = async (event) => {
  const idList = event.pathParameters?.id?.split(";") ?? [];
  const stopParams: EC2.StopInstancesRequest = {
    InstanceIds: idList,
    Force: true,
  };

  if (stopParams.InstanceIds === undefined) {
    return ResponseHelper.responseParameterError();
  }

  // todo: 判断instance id是否存在
  // let ec2ResList;
  // for (let id of idList) {
  //   ec2ResList.push(ec2.describeInstances({ "instance-id": id }).promise());
  // }
  //
  // Promise.all(ec2ResList)
  //
  // for (let i =0; i< ec2ResList.lenth(); i++)
  // {
  //   // 如果不存在则移除id
  // }

  let stopResult = ec2.stopInstances(stopParams, (err, data) => {
    err ? console.error(err) : console.log(data);
  });

  let stopRes = await stopResult.promise();
  // 停机成功后需要，记录一条信息表示这个实例是需要手动重启的，再关机检查event中，会判断是否再次启动
  let params: DynamoDB.BatchWriteItemInput = {
    RequestItems: { [Table.EC2_Status.tableName]: [] },
  };

  for (let id of idList) {
    params.RequestItems[Table.EC2_Status.tableName].push({
      PutRequest: {
        Item: {
          InstanceId: id,
          Reboot: 1,
          RebootAt: ms(),
        },
      },
    });
  }

  // Call DynamoDB to add the item to the table
  await dynamoDb.batchWrite(params).promise();
  // return ResponseHelper.responseOK(stopRes);
  return ResponseHelper.responseOK();
};
