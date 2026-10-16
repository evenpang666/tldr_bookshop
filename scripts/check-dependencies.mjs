import { dependenciesReady } from './environment.mjs';
process.exitCode = await dependenciesReady() ? 0 : 1;
