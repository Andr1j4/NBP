const cassandra = require('cassandra-driver');

const client = new cassandra.Client({
    contactPoints: ['192.168.122.230'],
    localDataCenter: 'datacenter1',
    keyspace: 'turnir'
});


module.exports = client;
