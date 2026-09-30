// Test-only wrapper: an in-memory instance of the shared D1-shaped SQLite
// shim. The implementation lives in relay/d1sqlite.mjs so relay.test.mjs and
// the plain-server relay (relay/server.mjs) run the exact same SQL through
// the exact same wrapper, file-backed for the server and in-memory here.
import { makeD1 as makeD1Impl } from "../relay/d1sqlite.mjs";

export function makeD1() {
  return makeD1Impl(":memory:");
}
