
const cds = require('@sap/cds');

const USERS = [
    'alice',
    'bob',
    'charlie',
    'david',
    'admin'
];

const BASE = 'http://localhost:4004/odata/v4/dealer/';

const HOME = {
    alice: BASE + 'PriceLists',
    bob: BASE + 'DiscountRequests',
    charlie: BASE + 'DiscountRequests',
    david: BASE + 'ApprovalDecisions',
    admin: BASE + 'ApprovalMatrix'
};

const ROLES = {
    alice: 'PricingAnalyst',
    bob: 'DealerSalesUser',
    charlie: 'RegionalManager',
    david: 'FinanceApprover',
    admin: 'PricingAdministrator'
};

// Read selected user from browser cookie
const getUser = (req) => {
    const cookie = req.headers.cookie || '';

    const match = /(?:^|;\s*)devuser=([^;]+)/.exec(cookie);

    const user = match
        ? decodeURIComponent(match[1])
        : null;

    return USERS.includes(user) ? user : 'alice';
};

cds.on('bootstrap', app => {

    // Never enable this switcher in production
    if (cds.env.profiles.includes('production')) {
        return;
    }

    // Only use with mocked authentication
    if (cds.env.requires.auth.kind !== 'mocked') {
        return;
    }

    console.log('[dev-auth] Development user switcher loaded');

    // Switch browser user
    app.get('/dev-login/:user', (req, res) => {

        const user = req.params.user;

        if (!USERS.includes(user)) {
            return res.status(404).send('Unknown user');
        }

        res.cookie('devuser', user, {
            path: '/',
            maxAge: 24 * 60 * 60 * 1000,
            sameSite: 'lax',
            httpOnly: true
        });

        console.log(`[dev-auth] Switched user to: ${user}`);

        res.redirect(
            '/.cap/table.html?url=' +
            encodeURIComponent(HOME[user])
        );
    });

    // Check selected browser user
    app.get('/dev-whoami', (req, res) => {

        const user = getUser(req);

        res.json({
            username: user,
            role: ROLES[user]
        });
    });

    // Development authentication middleware
    app.use((req, res, next) => {

        if (req.path.startsWith('/odata/')) {

            // Preserve credentials supplied by EchoAPI or another client
            const authorization = req.headers.authorization;

            if (authorization) {

                let username = 'external-auth';

                if (authorization.startsWith('Basic ')) {
                    try {
                        const decoded = Buffer.from(
                            authorization.slice(6),
                            'base64'
                        ).toString();

                        username = decoded.split(':')[0];
                    } catch (error) {
                        // CAP will validate the supplied credentials
                    }
                }

                console.log(
                    `[dev-auth] Using supplied credentials for ${username} -> ${req.method} ${req.path}`
                );

                return next();
            }

            // If no Authorization header exists, use browser cookie
            const user = getUser(req);

            const credentials = `${user}:${user}`;

            req.headers.authorization =
                'Basic ' +
                Buffer.from(credentials).toString('base64');

            console.log(
                `[dev-auth] ${user} -> ${req.method} ${req.path}`
            );
        }

        next();
    });

});
