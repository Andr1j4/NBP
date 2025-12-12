const redis = require('redis')


const redis = redis.createClient({
    url: 'redis://192.168.122.230:6379',
});

redis.on('error', (err) => console.log('Redis Client Error', err));

(async () => {
    await redis.connect();
})();

module.exports = redis;