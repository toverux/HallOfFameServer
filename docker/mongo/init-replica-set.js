// noinspection JSUnresolvedReference

try {
  rs.status();
} catch (error) {
  rs.initiate({
    _id: 'rs0',
    members: [{ _id: 0, host: 'localhost:27017' }]
  });
}
