// Small session store on top of the same Postgres database, so logins survive restarts.
module.exports = function (session) {
  class PgStore extends session.Store {
    constructor(db) {
      super();
      this.db = db;
      setInterval(() => { this.db.run('DELETE FROM sessions WHERE expires < ?', Date.now()).catch(() => {}); }, 60 * 60 * 1000).unref();
    }
    expiry(sess) {
      const e = sess && sess.cookie && sess.cookie.expires;
      return e ? new Date(e).getTime() : Date.now() + 24 * 3600 * 1000;
    }
    get(sid, cb) {
      this.db.get('SELECT data, expires FROM sessions WHERE sid = ?', sid)
        .then(row => {
          if (!row || Number(row.expires) < Date.now()) return cb(null, null);
          cb(null, JSON.parse(row.data));
        })
        .catch(cb);
    }
    set(sid, sess, cb) {
      this.db.run('INSERT INTO sessions(sid, data, expires) VALUES (?,?,?) ON CONFLICT (sid) DO UPDATE SET data = excluded.data, expires = excluded.expires',
        sid, JSON.stringify(sess), this.expiry(sess))
        .then(() => cb && cb(null)).catch(e => cb && cb(e));
    }
    destroy(sid, cb) {
      this.db.run('DELETE FROM sessions WHERE sid = ?', sid).then(() => cb && cb(null)).catch(e => cb && cb(e));
    }
    touch(sid, sess, cb) {
      this.db.run('UPDATE sessions SET expires = ? WHERE sid = ?', this.expiry(sess), sid).then(() => cb && cb(null)).catch(e => cb && cb(e));
    }
  }
  return PgStore;
};
