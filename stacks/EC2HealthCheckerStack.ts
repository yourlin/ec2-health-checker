import { Api, StackContext, Table, Topic, EventBus, Cron } from "sst/constructs";
import * as events from "aws-cdk-lib/aws-events";

export function EC2HealthCheckerStack({ stack }: StackContext) {
  const tableEC2Status = new Table(stack, "EC2_Status", {
    fields: {
      InstanceId: "string"
    },
    primaryIndex: { partitionKey: "InstanceId" },
    timeToLiveAttribute: "TTL"
  });
  // const tableEC2StatusConfig = new Table(stack, "EC2_Status_Config", {
  //   fields: {
  //     Rebooting: "number"
  //   },
  //   primaryIndex: { partitionKey: "Rebooting" },
  //   timeToLiveAttribute: "TTL"
  // });

  // EC2停止事件
  const bus = new EventBus(stack, "EC2HealthChecker", {
    defaults: {
      function: {
        // Bind the table name to our API
        bind: [tableEC2Status]
      }
    },
    cdk: {
      eventBus: events.EventBus.fromEventBusName(
        stack,
        "ImportedBus",
        "default"
      )
    },
    rules: {
      EC2_Stop_Event: {
        pattern: {
          source: ["aws.ec2"],
          detailType: ["EC2 Instance State-change Notification"],
          detail: {
            state: ["stopped"]
          }
        },
        targets: {
          restart: "packages/functions/src/event/ec2_event.stopEventReceive"
        }
      }
    }
  });

  // Create Topic
  const topic = new Topic(stack, "ec2-check-failed", {
    defaults: {
      function: {
        // Bind the table name to our API
        bind: [tableEC2Status]
      }
    },
    subscribers: {
      ec2DataAbnormal: "packages/functions/src/event/ec2_event.abnormalReceive"
    }
  });

  // 主动轮询EC2事件
  const cron = new Cron(stack, "EC2-Schedule-Check", {
    schedule: "rate(1 minute)",
    job: "packages/functions/src/event/ec2_event.ec2ScheduleCheck"
  });
  cron.bind([tableEC2Status]);

  // Create the HTTP API
  const api = new Api(stack, "Api", {
    defaults: {
      function: {
        // Bind the table name to our API
        bind: [tableEC2Status]
      }
    },
    routes: {
      "POST /ec2/reboot/{id}":
        "packages/functions/src/api/ec2_controller.reboot",
      "POST /ec2/forceStopAndStart/{id}":
        "packages/functions/src/api/ec2_controller.forceStopAndStart",
      "GET /ec2/abnormal": "packages/functions/src/api/ec2_controller.abnormal"
    }
  });

  // Allow the API to access the table and EC2
  api.attachPermissions([tableEC2Status, "ec2"]);
  // Allow lambda to access the table and EC2
  bus.attachPermissions([tableEC2Status, "ec2"]);
  topic.attachPermissions([tableEC2Status, "ec2"]);
  cron.attachPermissions([tableEC2Status, "ec2", "cloudwatch"]);

  // Show the API endpoint in the output
  stack.addOutputs({
    ApiEndpoint: api.url
  });
}
