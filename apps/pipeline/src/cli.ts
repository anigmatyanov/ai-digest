#!/usr/bin/env node
import { main } from "./run.js";

process.exitCode = await main();
