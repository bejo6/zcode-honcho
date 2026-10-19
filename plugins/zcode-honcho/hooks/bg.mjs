#!/usr/bin/env node
/**
 * Detached background worker for context refresh / dialectic.
 * Invoked as: node bg.mjs <jobPath>
 */

import { runBackgroundJob } from "./lib/inject.mjs";

const jobPath = process.argv[2];
if (!jobPath) process.exit(0);

runBackgroundJob(jobPath)
  .catch(() => {})
  .finally(() => process.exit(0));
