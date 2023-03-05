import { Api, StackContext, Table, Topic, EventBus } from "sst/constructs";
import * as events from "aws-cdk-lib/aws-events";

export function EC2HealthCheckerStack({ stack }: StackContext) {
  const table = new Table(stack, "EC2_Status", {
    fields: {
      InstanceId: "string",
    },
    primaryIndex: { partitionKey: "InstanceId" },
  });

  // EC2停止时间
  const bus = new EventBus(stack, "EC2HealthChecker", {
    defaults: {
      function: {
        // Bind the table name to our API
        bind: [table],
      },
    },
    cdk: {
      eventBus: events.EventBus.fromEventBusName(
        stack,
        "ImportedBus",
        "default"
      ),
    },
    rules: {
      EC2_Stop_Event: {
        pattern: {
          source: ["aws.ec2"],
          detailType: ["EC2 Instance State-change Notification"],
          detail: {
            state: ["stopped"],
          },
        },
        targets: {
          restart: "packages/functions/src/event/ec2_event.stopEventReceive",
        },
      },
    },
  });

  // Create Topic
  const topic = new Topic(stack, "ec2-check-failed-email", {
    defaults: {
      function: {
        // Bind the table name to our API
        bind: [table],
      },
    },
    subscribers: {
      ec2DataAbnormal: "packages/functions/src/event/ec2_event.abnormalReceive",
    },
  });

  // Create the HTTP API
  const api = new Api(stack, "Api", {
    defaults: {
      function: {
        // Bind the table name to our API
        bind: [table],
      },
    },
    routes: {
      "POST /ec2/reboot/{id}":
        "packages/functions/src/api/ec2_controller.reboot",
      "POST /ec2/forceStopAndStart/{id}":
        "packages/functions/src/api/ec2_controller.forceStopAndStart",
      "GET /ec2/abnormal": "packages/functions/src/api/ec2_controller.abnormal",
    },
  });

  // Allow the API to access the table and EC2
  api.attachPermissions([table, "ec2"]);
  // Allow lambda to access the table and EC2
  bus.attachPermissions([table, "ec2"]);

  // Show the API endpoint in the output
  stack.addOutputs({
    ApiEndpoint: api.url,
  });
}
