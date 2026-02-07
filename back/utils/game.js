const { asUuid } = require("./uuid");

function parseTimeControl(tc) {
    const s = (tc || "5+0").toString().trim();
    const m = s.match(/^(\d+)\s*\+\s*(\d+)$/);
    const baseMin = m ? parseInt(m[1], 10) : 5;
    const incSec = m ? parseInt(m[2], 10) : 0;
    return { baseMs: baseMin * 60_000, incMs: incSec * 1000, tc: `${baseMin}+${incSec}` };
}

function settleClock(clock, nowMs) {
    if (!clock.running || !clock.last_tick) return { flag: false };

    const elapsed = Math.max(0, nowMs - clock.last_tick);

    if (clock.active === "w") {
        clock.w_ms -= elapsed;
        if (clock.w_ms <= 0) {
            clock.w_ms = 0;
            return { flag: true, loser: "w" };
        }
    } else {
        clock.b_ms -= elapsed;
        if (clock.b_ms <= 0) {
            clock.b_ms = 0;
            return { flag: true, loser: "b" };
        }
    }

    clock.last_tick = nowMs;
    return { flag: false };
}

async function getOrInitClock(redisClient, cassandraClient, gameId) {
    const clockKey = `game:${gameId}:clock`;
    const existing = await redisClient.hGetAll(clockKey);

    if (existing && Object.keys(existing).length > 0) {
        return {
            w_ms: parseInt(existing.w_ms || "0", 10),
            b_ms: parseInt(existing.b_ms || "0", 10),
            active: existing.active || "w",
            running: existing.running === "1",
            last_tick: parseInt(existing.last_tick || "0", 10),
            inc_ms: parseInt(existing.inc_ms || "0", 10),
            tc: existing.tc || null,
        };
    }

    let timeControl = "5+0";
    try {
        const mRes = await cassandraClient.execute(
            "SELECT tournament_id FROM matches_by_game WHERE game_id = ?",
            [gameId],
            { prepare: true }
        );
        if (mRes.rowLength) {
            const tid = mRes.rows[0].tournament_id;
            if (tid) {
                const tRes = await cassandraClient.execute(
                    "SELECT time_control FROM tournaments WHERE tournament_id = ?",
                    [tid],
                    { prepare: true }
                );
                if (tRes.rowLength && tRes.rows[0].time_control) {
                    timeControl = tRes.rows[0].time_control;
                }
            }
        }
    } catch { }

    const { baseMs, incMs, tc } = parseTimeControl(timeControl);

    const init = {
        w_ms: baseMs,
        b_ms: baseMs,
        active: "w",
        running: false,
        last_tick: 0,
        inc_ms: incMs,
        tc,
    };

    await redisClient.hSet(clockKey, {
        w_ms: String(init.w_ms),
        b_ms: String(init.b_ms),
        active: init.active,
        running: "0",
        last_tick: "0",
        inc_ms: String(init.inc_ms),
        tc: init.tc,
    });

    return init;
}

async function saveClock(redisClient, gameId, clock) {
    const clockKey = `game:${gameId}:clock`;
    await redisClient.hSet(clockKey, {
        w_ms: String(clock.w_ms),
        b_ms: String(clock.b_ms),
        active: clock.active,
        running: clock.running ? "1" : "0",
        last_tick: String(clock.last_tick || 0),
        inc_ms: String(clock.inc_ms || 0),
        tc: clock.tc || "",
    });
}

async function scheduleTimeoutKey(redisClient, gameId, clock) {
    const key = `game:${gameId}:timeout`;

    if (!clock.running) {
        await redisClient.del(key);
        return;
    }

    const remainingMs = clock.active === "w" ? clock.w_ms : clock.b_ms;
    const ttl = Math.max(1, remainingMs);

    await redisClient.set(key, `active=${clock.active}`, { PX: ttl });
}

module.exports = {
    parseTimeControl,
    settleClock,
    getOrInitClock,
    saveClock,
    scheduleTimeoutKey,
};
