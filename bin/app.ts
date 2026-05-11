#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { AppStack } from '../lib/app-stack';

const app = new cdk.App();

// Cert is provisioned via a custom resource pinned to us-east-1; the main
// stack itself can deploy in any region the user selects (via
// CDK_DEFAULT_REGION or the awsRegion env var injected by hereya).
const region =
  process.env['CDK_DEFAULT_REGION'] ?? process.env['awsRegion'] ?? 'us-east-1';

new AppStack(app, process.env.STACK_NAME!, {
  env: {
    account: process.env['CDK_DEFAULT_ACCOUNT'],
    region,
  },
});
