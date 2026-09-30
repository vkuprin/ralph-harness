import { describe, expect, test } from "bun:test";
import { copyFileSync, writeFileSync } from "node:fs";
import { Fx, alive, join, read, setup, until } from "../helpers/index.ts";

const fx = new Fx("identity");

/** A stranger: a process that is not a loop and now owns the number a dead loop left behind. */
function stranger(): Bun.Subprocess {
  // Long enough to outlive the checks around it, which each test kills it
  // after: on a Windows runner a `ralph status` and a `ralph stop`, reading
  // processes through CIM, took more than 41s, and a stranger that had simply
  // finished read as one the stop had killed.
  return Bun.spawn(["sleep", "600"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
}

describe("a PID is not an identity: ralph.pid and ralph.lock left by a dead loop", () => {
  // A loop that ends by `kill -9`, the OOM killer or a reboot leaves both files
  // behind holding a number the kernel then hands to somebody else.
  const app = fx.p("app-p");
  const home = fx.p("home-p");
  const stale = join(home, "stale");
  const other = join(home, "other");
  let staleStatus = "";
  let stopRc = 0;
  let pidStrangerAlive = false;
  let otherStatus = "";
  let lockStrangerAlive = false;

  setup(async () => {
    fx.makeRepo(app, fx.p("remote-p.git"));
    const S = fx.stub("stub-p", ["nothing"]);
    fx.makeLoop(stale, app, { MAX_ITER: 1 });

    const bystander = stranger();
    try {
      writeFileSync(join(stale, "ralph.pid"), `${bystander.pid}\n`);
      staleStatus = fx.cli(home, ["status", "stale"]).out;
      stopRc = fx.cli(home, ["stop", "stale"]).code;
      pidStrangerAlive = alive(bystander.pid);
    } finally {
      bystander.kill();
    }

    // The recycled number could be another loop's, which is why the check is
    // this loop's own command line and not merely "some loop is alive".
    const S2 = fx.stub("stub-p2", ["sleep"]);
    fx.makeLoop(other, app, { MAX_ITER: 1, ITER_TIMEOUT: 600 });
    fx.cli(home, ["start", "other"], { STUB_DIR: S2 });
    try {
      await until(() => read(join(S2, "modes.done")) !== "", 10);
      copyFileSync(join(other, "ralph.pid"), join(stale, "ralph.pid"));
      fx.cli(home, ["stop", "stale"]);
      otherStatus = fx.cli(home, ["status", "other"]).out;
    } finally {
      fx.cli(home, ["stop", "other"]);
    }

    // The lock is the loop's own, and a recycled PID there stopped it starting at all.
    const holder = stranger();
    try {
      writeFileSync(join(stale, "ralph.lock"), `${holder.pid}\n`);
      await fx.runLoop(stale, S);
      lockStrangerAlive = alive(holder.pid);
    } finally {
      holder.kill();
    }
  });

  test("status does not call a recycled PID a running loop", () => {
    expect(staleStatus).toContain("stopped");
  });
  test("stop says the loop is not running", () => {
    expect(stopRc).not.toBe(0);
  });
  test("stop leaves the stranger who now owns that PID alone", () => {
    expect(pidStrangerAlive).toBe(true);
  });
  test("stopping one loop does not stop the loop next door", () => {
    expect(otherStatus).toContain("running");
  });
  test("a lock left by a dead loop does not block the next start", () => {
    expect(read(join(stale, "ralph.log"))).toContain("ralph finished");
  });
  test("the stranger holding the lock's PID survived that too", () => {
    expect(lockStrangerAlive).toBe(true);
  });
});
