#!/usr/bin/env node
import { Lane } from "../core/lane.js";
import { ParsedArgs, parseArgs } from "./args.js";
declare function dispatch(args: ParsedArgs): Promise<void>;
export { dispatch, parseArgs };
export type { Lane };
