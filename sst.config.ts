import { SSTConfig } from "sst";
import { EC2HealthCheckerStack } from "./stacks/EC2HealthCheckerStack"
import { Api } from "sst/constructs";

export default {
  config(_input) {
    return {
      name: "ec2-heath-checker",
      region: "us-east-1",
    };
  },
  stacks(app) {
    app.stack(EC2HealthCheckerStack)
  },
} satisfies SSTConfig;
