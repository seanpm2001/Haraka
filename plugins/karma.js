// karma - reward good and penalize bad mail senders

var ipaddr = require('ipaddr.js');
var redis = require('redis');
var db;

exports.register = function () {
    var plugin = this;

    this.register_hook('init_master',  'karma_onInit');
    this.register_hook('init_child',   'karma_onInit');
    this.register_hook('deny',         'karma_onDeny');
    this.register_hook('lookup_rdns',  'karma_onConnect');
    this.register_hook('mail',         'karma_onMailFrom');
    this.register_hook('rcpt',         'karma_onRcptTo');
    this.register_hook('data',         'karma_onData');
    this.register_hook('data_post',    'karma_onDataPost');
    this.register_hook('disconnect',   'karma_onDisconnect');
};

exports.karma_onInit = function (next,server) {
    var config     = this.config.get('karma.ini');
    var redis_ip  = '127.0.0.1';
    var redis_port = '6379';
    if ( config.redis ) {
        redis_ip = config.redis.server_ip || '127.0.0.1';
        redis_port = config.redis.server_port || '6379';
    };
    db = redis.createClient(redis_port, redis_ip);
    return next();
};

exports.karma_onConnect = function (next, connection) {
    var plugin = this;
    var config = this.config.get('karma.ini');

    initConnectionNote(connection, config);

    var r_ip = connection.remote_ip;
    var dbkey = 'karma|'+r_ip;
    var expire = (config.main.expire_days || 60) * 86400; // convert to days

    function initRemoteIP () {
        db.multi()
            .hmset(dbkey, {'penalty_start_ts': 0, 'bad': 0, 'good': 0, 'connections': 1})
            .expire(dbkey, expire)
            .exec();
        connection.logdebug(plugin,"first connect");
    };

    db.multi()
        .get('concurrent|'+r_ip)
        .hgetall(dbkey)
        .exec( function redisResults (err,replies) {
            if (err) {
                connection.logdebug(plugin,"err: "+err);
                return next();
            };

            if (replies[1] === null) { initRemoteIP(); return next(); };

            db.hincrby(dbkey, 'connections', 1); // increment total connections
            db.expire(dbkey, expire);            // extend expiration date

            var dbr = replies[1]; // 2nd element of DB reply is our karma object
            var history = (dbr.good || 0) - (dbr.bad || 0);
            connection.notes.karma.history = history;

            var summary = dbr.bad+" bad, "+dbr.good+" good, "
                         +dbr.connections+" connects, "+history+" history";

            var too_many = checkConcurrency(plugin, 'concurrent|'+r_ip, replies[0], history);
            if ( too_many ) {
                connection.loginfo(plugin, too_many + ", ("+summary+")");
                return next(DENYSOFT, too_many);
            };

            if (dbr.penalty_start_ts === '0') {
                connection.loginfo(plugin, "no penalty, "+karmaSummary(connection));
                return next();
            }

            var days_old = (Date.now() - Date.parse(dbr.penalty_start_ts)) / 86.4;
            var penalty_days = config.main.penalty_days;
            if (days_old >= penalty_days) {
                connection.loginfo(plugin, "penalty expired, "+karmaSummary(connection));
                return next();
            }

            var left = +( penalty_days - days_old ).toFixed(2);
            var mess = "Bad karma, you can try again in "+left+" more days.";

            return next(DENY, mess);
        });

    checkAwards(config, connection, plugin);
};

exports.karma_onDeny = function (next, connection, params) {
    /* params
    ** [0] = plugin return value (constants.deny or constants.denysoft)
    ** [1] = plugin return message
    */

    var pi_name     = params[2];
    var pi_function = params[3];
    var pi_params   = params[4];
    var pi_hook     = params[5];

    var plugin = this;
    var transaction = connection.transaction;

    var config = this.config.get('karma.ini');
    initConnectionNote(connection, config);

// TO CONSIDER: decrement karma two points for a 5XX deny?
    connection.notes.karma.connection--;
    connection.notes.karma.penalties.push(pi_name);

    connection.loginfo(plugin, 'deny, '+karmaSummary(connection));

    checkAwards(config, connection, plugin);
    return next();
};

exports.karma_onMailFrom = function (next, connection, params) {
    var plugin = this;
    var config = this.config.get('karma.ini');

    checkSpammyTLD(params[0], config, connection, plugin);
    checkSyntaxMailFrom(connection, plugin);

    checkAwards(config, connection, plugin);
    connection.loginfo(plugin, karmaSummary(connection));
    return next();
};

exports.karma_onRcptTo = function (next, connection, params) {
    var plugin = this;
    var rcpt = params[0];
    var config = this.config.get('karma.ini');

    checkSyntaxRcptTo(connection, plugin);
    var too_many = checkMaxRecipients(connection, plugin, config);
    if (too_many) return next(DENY, too_many);

    checkAwards(config, connection, plugin);
    connection.loginfo(plugin, karmaSummary(connection));
    return next();
};

exports.karma_onData = function (next, connection) {
// cut off bad senders at DATA to prevent transferring the message
    var config = this.config.get('karma.ini');
    var negative_limit = config.threshhold.negative || -5;
    var karma = connection.notes.karma * 1;

    if (karma.connection <= negative_limit) {
        return next(DENY, "very bad karma score: "+karma);
    }

    checkAwards(config, connection, this);
    return next();
}

exports.karma_onDataPost = function (next, connection) {
    connection.transaction.add_header('X-Haraka-Karma',
        karmaSummary(connection)
    );
    var config = this.config.get('karma.ini');
    checkAwards(config, connection, this);
    return next();
}

exports.karma_onDisconnect = function (next, connection) {
    var plugin = this;
    var config = this.config.get('karma.ini');

    if ( config.concurrency ) db.incrby('concurrent|'+connection.remote_ip, -1);

    var k = connection.notes.karma;
    if (!k) { connection.logerror(plugin, "karma note missing!"); return next(); };

    if (!k.connection) {
        connection.loginfo(plugin, "neutral: "+karmaSummary(connection));
        return next();
    };

    var key = 'karma|'+connection.remote_ip;
    var history = k.history;

    if (config.threshhold) {
        var pos_lim = config.threshhold.positive || 2;

        if (k.connection > pos_lim) {
            db.hincrby(key, 'good', 1);
            connection.loginfo(plugin, "positive: "+karmaSummary(connection));
            return next();
        };

        var bad_limit = config.threshhold.negative || -3;
        if (k.connection < bad_limit) {
            db.hincrby(key, 'bad', 1);
            history--;

            if (history <= config.threshhold.history_negative) {
                if (history < -5) {
                    db.hset(key, 'penalty_start_ts', addDays(Date(), history * -1 ) );
                    connection.loginfo(plugin, "penalty box bonus!: "+karmaSummary(connection));
                }
                else {
                    db.hset(key, 'penalty_start_ts', Date());
                    connection.loginfo(plugin, "penalty box: "+karmaSummary(connection));
                }
                return next();
            }
        }
    };
    checkAwards(config, connection, plugin);
    connection.loginfo(plugin, "no action, "+karmaSummary(connection));
    return next();
};

function karmaSummary(c) {
    var k = c.notes.karma;
    return '('
        +'conn:'+k.connection
        +', hist: '+k.history
        +(k.penalties.length ? ', penalties: '+k.penalties : '')
        +(k.awards.length    ? ', awards: '   +k.awards    : '')
        +')';
}

function addDays(date, days) {
    var result = new Date(date);
    result.setDate(date.getDate() + days);
    return result;
}

function checkAwards (config, connection, plugin) {
    if (!connection.notes.karma) return;
    if (!connection.notes.karma.todo) return;
    if (!plugin) plugin = connection;
    var awards = config.awards;

    Object.keys(connection.notes.karma.todo).forEach(function(key) {
        var e = key.split('@').slice(0,2);
        var suffix = e[0];
        var wants = e[1];

        // assemble the object path using the note name
        var note = assembleNoteObj(connection, suffix);
        if (note == null || note === false) {
            // connection.logdebug(plugin, "no connection note: "+key);
            if (!connection.transaction) return;
            note = assembleNoteObj(connection.transaction, suffix);
            if (note == null || note === false) {
                // connection.logdebug(plugin, "no transaction note: "+key);
                return;
            }
        };

        if (wants && note && (wants !== note)) {
            connection.logdebug(plugin, "key "+suffix+" wants: "+wants+" but got: "+note);
            return;
        };

        var karma_to_apply = connection.notes.karma.todo[key];
        if (!karma_to_apply) return;
        if ( Number(karma_to_apply) === 'NaN' ) return;  // garbage in config

        connection.notes.karma.connection += karma_to_apply * 1;
        connection.loginfo(plugin, "applied "+key+" karma: "+karma_to_apply);
        delete connection.notes.karma.todo[key];

        if ( karma_to_apply > 0 ) { connection.notes.karma.awards.push(key); };
        if ( karma_to_apply < 0 ) { connection.notes.karma.penalties.push(key); };
    });
}

function checkConcurrency(plugin, con_key, val, history) {
    var config = plugin.config.get('karma.ini');

    if ( !config.concurrency ) return;

    var count = val || 0;    // add this connection
    count++;
    db.incr(con_key);        // increment Redis, (creates if needed)
    db.expire(con_key, 4 * 60);     // expire after 4 min

    var reject=0;
    if (history <  0 && count > config.concurrency.bad) reject++;
    if (history >  0 && count > config.concurrency.good)    reject++;
    if (history == 0 && count > config.concurrency.neutral) reject++;
    if (reject) return "too many connections for you: "+count;
    return;
};

function checkMaxRecipients(connection, plugin, config) {
    if (!config.recipients) return;     // disabled in config file
    var c = connection.rcpt_count;
    var count = c.accept + c.tempfail + c.reject + 1;
    if ( count <= 1 ) return;           // everybody is allowed one

    connection.logdebug(plugin, "recipient count: "+count );

    var desc = history > 3 ? 'good' : history >= 0 ? 'neutral' : 'bad';

    var cr = config.recipients;

    // the deeds of their past shall not go unnoticed!
    var history = connection.notes.karma.history;
    if ( history > 3 && count <= cr.good) return;
    if ( history > -1 && count <= cr.neutral) return;

    // this is *more* strict than history, b/c they have fewer opportunity
    // to score positive karma this early in the connection. senders with
    // good history will rarely see these limits.
    var karma = connection.notes.karma.connection;
    if ( karma >  3 && count <= cr.good) return;
    if ( karma >= 0 && count <= cr.neutral) return;

    return 'too many recipients ('+count+') for '+desc+' karma';
}

function checkSpammyTLD(mail_from, config, connection, plugin) {
    if (!config.spammy_tlds) return;

    var from_tld  = mail_from.host.split('.').pop();
    // connection.logdebug(plugin, "from_tld: "+from_tld);

    var tld_penalty = (config.spammy_tlds[from_tld] || 0) * 1; // force numeric
    if (tld_penalty === 0) return;

    connection.loginfo(plugin, "spammy TLD: "+tld_penalty);
    connection.notes.karma.connection += tld_penalty;
    connection.notes.karma.penalties.push('spammy.TLD');
};

function checkSyntaxMailFrom(connection, plugin) {
    var full_from = connection.current_line;
    // connection.logdebug(plugin, "mail_from: "+full_from);

// look for an illegal (RFC 5321,2821,821) space in envelope from
    if (full_from.toUpperCase().substring(0,11) === 'MAIL FROM:<' ) return;

    connection.loginfo(plugin, "illegal envelope address format: "+full_from );
    connection.notes.karma.connection--;
    connection.notes.karma.penalties.push('rfc5321.MailFrom');
};

function checkSyntaxRcptTo(connection, plugin) {
    // check for an illegal RFC (2)821 space in envelope recipient
    var full_rcpt = connection.current_line;
    if ( full_rcpt.toUpperCase().substring(0,9) === 'RCPT TO:<' ) return;

    connection.loginfo(plugin, "illegal envelope address format: "+full_rcpt );
    connection.notes.karma.connection--;
    connection.notes.karma.penalties.push('rfc5321.RcptTo');
};

function initConnectionNote(connection, config) {
    if (connection.notes.karma) return; // init once per connection
    connection.notes.karma = {
        connection: 0,
        history: 0,
        awards: [],
        penalties: [ ],
        todo: {},
    };

    // todo is a list of connection/transaction notes to 'watch' for.
    // When discovered, award their karma points to the connection
    // and remove them from todo.
    var awards = config.awards;
    if (!awards) return;
    Object.keys(awards).forEach(function(key) {
        connection.notes.karma.todo[key] = awards[key];
    });
};

function assembleNoteObj(prefix, key) {
    var note = prefix;
    var parts = key.split('.');
    while(parts.length > 0) {
        note = note[parts.shift()];
        if (note == null) break;
    }
    return note;
};
