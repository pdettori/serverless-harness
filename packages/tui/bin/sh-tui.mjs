#!/usr/bin/env node
// Registers the tsx loader so the TypeScript sources run directly, the way every package here runs.
import { register } from 'tsx/esm/api';

register();
await import('../src/main.ts');
