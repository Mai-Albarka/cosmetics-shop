// Small session store on top of the same SQLite database, so logins survive restarts.
module.exports = function (session) {
  class SqliteStore extends session.Store {
    constructor(db) {
      super();
      db.exec('CREATE TABLE IF NOT EXISTS sessions (sid TEXT PRIMARY KEY, data TEXT NOT NULL, expires INTEGER NOT NULL)');
      this.q = {
        get: db.prepare('SELECT data, expires FROM sessions WHERE sid = ?'),
        set: db.prepare('INSERT INTO sessions(sid, data, expires) VALUES (?,?,?) ON CONFLICT(sid) DO UPDATE SET data = excluded.data, expires = excluded.expires'),
        del: db.prepare('DELETE FROM sessions WHERE sid = ?'),
        touch: db.prepare('UPDATE sessions SET expires = ? WHERE sid = ?'),
        clean: db.prepare('DELETE FROM sessions WHERE expires < ?')
      };
      setInterval(() => { try { this.q.clean.run(Date.now()); } catch {} }, 60 * 60 * 1000).unref();
    }
    expiry(sess) {
      const e = sess && sess.cookie && sess.cookie.expires;
      return e ? new Date(e).getTime() : Date.now() + 24 * 3600 * 1000;
    }
    get(sid, cb) {
      try {
        const row = this.q.get.get(sid);
        if (!row || row.expires < Date.now()) return cb(null, null);
        cb(null, JSON.parse(row.data));
      } catch (e) { cb(e); }
    }
    set(sid, sess, cb) { try { this.q.set.run(sid, JSON.stringify(sess), this.expiry(sess)); cb && cb(null); } catch (e) { cb && cb(e); } }
    destroy(sid, cb) { try { this.q.del.run(sid); cb && cb(null); } catch (e) { cb && cb(e); } }
    touch(sid, sess, cb) { try { this.q.touch.run(this.expiry(sess), sid); cb && cb(null); } catch (e) { cb && cb(e); } }
  }
  return SqliteStore;
};
