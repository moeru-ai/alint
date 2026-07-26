interface ProviderJob {
  providerId: string
}

interface ScheduledJob<Job> {
  index: number
  job: Job
}

/** Runs FIFO job queues independently so one provider's cap cannot throttle or overload another provider. */
export async function scheduleProviderJobs<Job extends ProviderJob, Result>(
  jobs: readonly Job[],
  concurrencyByProvider: Readonly<Record<string, number>>,
  execute: (job: Job, index: number) => Promise<Result>,
): Promise<Result[]> {
  const queues = new Map<string, Array<ScheduledJob<Job>>>()

  for (const [index, job] of jobs.entries()) {
    const queue = queues.get(job.providerId) ?? []
    queue.push({ index, job })
    queues.set(job.providerId, queue)
  }

  const limits = new Map<string, number>()

  for (const providerId of queues.keys()) {
    const limit = concurrencyByProvider[providerId] ?? 1

    if (!Number.isInteger(limit) || limit < 1) {
      throw new RangeError(`Benchmark concurrency for provider "${providerId}" must be a positive integer.`)
    }

    limits.set(providerId, limit)
  }

  const results: Array<undefined | { value: Result }> = Array.from({ length: jobs.length })
  const workers: Array<Promise<void>> = []

  for (const [providerId, queue] of queues) {
    const workerCount = Math.min(limits.get(providerId)!, queue.length)
    let nextJobIndex = 0

    for (let workerIndex = 0; workerIndex < workerCount; workerIndex += 1) {
      workers.push((async () => {
        while (nextJobIndex < queue.length) {
          const scheduled = queue[nextJobIndex]
          nextJobIndex += 1

          if (scheduled !== undefined) {
            results[scheduled.index] = {
              value: await execute(scheduled.job, scheduled.index),
            }
          }
        }
      })())
    }
  }

  await Promise.all(workers)

  return results.map((result, index) => {
    if (result === undefined) {
      throw new Error(`Benchmark scheduler did not complete job ${index}.`)
    }

    return result.value
  })
}
