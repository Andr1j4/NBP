/**
 * Retry a query with exponential backoff
 * Useful for eventual consistency issues
 */
async function queryWithRetry(
    cassandra,
    queryStr,
    params,
    options = {},
    maxRetries = 3,
    initialDelayMs = 100
) {
    const { prepare = true } = options;
    let lastError = null;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            if (attempt > 0) {
                const delayMs = initialDelayMs * Math.pow(2, attempt - 1);
                console.log(`[RETRY] Attempt ${attempt + 1}/${maxRetries}, waiting ${delayMs}ms`);
                await new Promise(r => setTimeout(r, delayMs));
            }

            const result = await cassandra.execute(queryStr, params, { prepare });

            if (result.rowLength > 0 || attempt === maxRetries - 1) {
                return result;
            }

            console.log(`[RETRY] No rows found, retrying...`);
        } catch (err) {
            lastError = err;
            console.warn(`[RETRY] Attempt ${attempt + 1} failed:`, err.message);

            if (attempt === maxRetries - 1) {
                throw err;
            }
        }
    }

    throw lastError;
}

module.exports = { queryWithRetry };
