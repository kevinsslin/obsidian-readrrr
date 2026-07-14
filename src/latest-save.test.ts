import { describe, expect, it, vi } from "vitest";
import { LatestSave } from "./latest-save";

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const flush = async () => {
  for (let i = 0; i < 6; i++) await Promise.resolve();
};

describe("LatestSave", () => {
  it("coalesces updates during an active save into the latest snapshot", async () => {
    const first = deferred();
    const saved: number[] = [];
    const save = vi.fn(async (value: number) => {
      saved.push(value);
      if (value === 1) await first.promise;
    });
    const queue = new LatestSave(save);

    const initial = queue.enqueue(1);
    const second = queue.enqueue(2);
    const latest = queue.enqueue(3);
    expect(second).toBe(initial);
    expect(latest).toBe(initial);
    expect(saved).toEqual([1]);

    first.resolve();
    await initial;
    expect(saved).toEqual([1, 3]);
  });

  it("starts a new save after the prior batch completes", async () => {
    const save = vi.fn(async (_value: string) => undefined);
    const queue = new LatestSave(save);

    await queue.enqueue("first");
    await flush();
    await queue.enqueue("second");
    expect(save.mock.calls.map(([value]) => value)).toEqual(["first", "second"]);
  });
});
