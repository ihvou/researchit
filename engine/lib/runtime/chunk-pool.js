function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}

export async function runChunkPool({
  initialChunks = [],
  concurrency = 1,
  processChunk,
} = {}) {
  if (typeof processChunk !== "function") {
    throw new Error("runChunkPool requires a processChunk function");
  }

  const queue = [...ensureArray(initialChunks)];
  const results = [];
  const workerLimit = Math.max(1, Number(concurrency) || 1);
  let activeWorkers = 0;
  let peakWorkerCount = 0;
  let stopped = false;

  return new Promise((resolve, reject) => {
    const enqueue = (chunks = [], { front = false } = {}) => {
      const items = ensureArray(chunks).filter(Boolean);
      if (!items.length) return;
      if (front) queue.unshift(...items);
      else queue.push(...items);
    };

    const pump = () => {
      if (stopped) return;
      if (!queue.length && activeWorkers === 0) {
        resolve({
          results,
          peakWorkerCount,
        });
        return;
      }

      while (!stopped && activeWorkers < workerLimit && queue.length > 0) {
        const chunk = queue.shift();
        activeWorkers += 1;
        peakWorkerCount = Math.max(peakWorkerCount, activeWorkers);

        Promise.resolve()
          .then(() => processChunk(chunk, { enqueue }))
          .then((outcome) => {
            if (!outcome || typeof outcome !== "object") return;
            if (Array.isArray(outcome?.children) && outcome.children.length) {
              enqueue(outcome.children, { front: outcome.enqueueFront === true });
            }
            if (Array.isArray(outcome?.results) && outcome.results.length) {
              results.push(...outcome.results);
            } else if (Object.prototype.hasOwnProperty.call(outcome, "result")) {
              results.push(outcome.result);
            }
          })
          .catch((err) => {
            stopped = true;
            reject(err);
          })
          .finally(() => {
            activeWorkers = Math.max(0, activeWorkers - 1);
            pump();
          });
      }
    };

    pump();
  });
}

