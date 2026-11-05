// One shared browser drives Flow, so work runs strictly one task at a time, in submission order.
let tail = Promise.resolve();
let waiting = 0;

// Number of tasks queued or running (0 means the lane is idle).
export function flowLaneLength() {
  return waiting;
}

export function enqueueFlowWork(task) {
  waiting += 1;
  const result = tail.then(() => task()).finally(() => {
    waiting -= 1;
  });
  tail = result.catch(() => {});
  return result;
}
