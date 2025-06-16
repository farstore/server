const express = require('express');
const mysql = require('mysql2/promise');
const helmet = require('helmet');
const cors = require('cors');
const bodyParser = require('body-parser');
const { ethers } = require('ethers');
const dotenv = require('dotenv');
const path = require('path');
const schedule = require('node-schedule');
const { v4 } = require('uuid');
const { dirname } = require('path');
const { fileURLToPath } = require('url');
const { JsonRpcProvider } = require('ethers');
const farstoreAbi = require('./abi/farstore.json');
const farstoreBatchReadAbi = require('./abi/farstore-batch-read.json');
const uniswapV3FactoryAbi = require('./abi/uniswap-v3-factory.json');
const erc20Abi = require('./abi/erc-20.json');
const launcherAbi = require('./abi/launcher.json');

dotenv.config({ path: path.join(__dirname, '/.env') });

// Initialize the DB
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0 // No limit
});

const app = express();
const port = process.env.SERVER_PORT;

// Connect to the Base network
const WETH = '0x4200000000000000000000000000000000000006';
const UNISWAP_V3_FACTORY = '0x33128a8fC17869897dcE68Ed026d694621f6FDfD';
const provider = new JsonRpcProvider(process.env.BASE_JSON_RPC_URL);
const farstoreContract = new ethers.Contract(process.env.FARSTORE_CONTRACT, farstoreAbi, provider);
const farstoreBatchReadContract = new ethers.Contract(process.env.FARSTORE_BATCH_READ_CONTRACT, farstoreBatchReadAbi, provider);
const uniswapV3FactoryContract = new ethers.Contract(UNISWAP_V3_FACTORY, uniswapV3FactoryAbi, provider);
const wethContract = new ethers.Contract(WETH, erc20Abi, provider);
const launcherContract = new ethers.Contract(process.env.LAUNCHER_CONTRACT, launcherAbi, provider);

function jsonResponse(res, error, results) {
  if (error) {
    res.status(500);
    res.set('content-type', 'application/json');
    res.send({
      errors: [error.toString()]
    });
  }
  else {
    res.status(200);
    res.set('content-type', 'application/json');
    res.send(JSON.stringify({
      results: results
    }));
  }
}

function repeat(template, occurences) {
  return `,${template}`.repeat(occurences).slice(1);
}

const directives = helmet.contentSecurityPolicy.getDefaultDirectives();
directives['default-src'] = ["*", "'self'"];
directives['script-src'] = [ "*", "'self'", "'unsafe-inline'" ];
directives['img-src'] = [ "*", "data:" ];

app.use(helmet({
  crossOriginEmbedderPolicy: false,
  contentSecurityPolicy: {
    directives
  }
}));

app.use(cors({
  credentials: true,
  origin: true, // Allows all origins
  optionsSuccessStatus: 200 // some legacy browsers (IE11, various SmartTVs) choke on 204
}));

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
// app.use(express.static('build'));

let ONCHAIN_DATA_CACHE = {};
let API_DOMAIN_CACHE = {};

function getApiDomain(req) {
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.split(' ')[1];
  return API_DOMAIN_CACHE[token];
}

function getOnchainMetadata(domain) {
  return ONCHAIN_DATA_CACHE[domain] || {
    token: null,
    liquidity: 0.0,
    owner: '0x0000000000000000000000000000000000000000'
  }
}

async function getTokenEthLiquidity(token) {
  let liquidity = 0;
  try {
    response = await fetch(`https://api.dexscreener.com/token-pairs/v1/base/${token}`, {
      method: "GET",
    });
  } catch (e) {
    throw new Error(`Unable to fetch liquidity for token: ${token}`);
  }
  let json = null;
  try {
    markets = await response.json();
  } catch (e) {
    throw new Error(`Unable to parse liquidity for token: ${token}`);
  }
  markets.forEach(market => {
    if (market.baseToken.address == token) {
      if (
        market.quoteToken.address == '0x4200000000000000000000000000000000000006' ||
        market.quoteToken.address == '0x0000000000000000000000000000000000000000'
      ) {
        liquidity += market.liquidity.quote;
      }
    } else if (market.quoteToken.address == token) {
      if (
        market.baseToken.address == '0x4200000000000000000000000000000000000006' ||
        market.baseToken.address == '0x0000000000000000000000000000000000000000'
      ) {
        liquidity += market.liquidity.base;
      }
    }
  });
  return liquidity;
}

async function syncApp(rawDomain) {
  const domain = rawDomain.toLowerCase();
  try {
    let response = null;
    try {
      response = await fetch(`https://${domain}/.well-known/farcaster.json`, {
        method: "GET",
      });
    } catch (e) {
      throw new Error(`Unable to fetch https://${domain}/.well-known/farcaster.json`);
    }
    let json = null;
    try {
      json = await response.json();
    } catch (e) {
      throw new Error(`Unable to parse https://${domain}/.well-known/farcaster.json`);
    }
    if (!json.frame || !json.frame.name) {
      throw new Error(`Missing metadata in https://${domain}/.well-known/farcaster.json`);
    }
    await pool.query(
      `
      INSERT INTO app (domain, frame_json, last_check_attempt, last_check_success)
      VALUES (?,?,NOW(),NOW())
      ON DUPLICATE KEY UPDATE
        frame_json = VALUES(frame_json),
        last_check_attempt = NOW(),
        last_check_success = NOW()
      `,
      [ domain, JSON.stringify(json.frame) ]
    );
    return json.frame;
  } catch (e) {
    await pool.query(
      `
      UPDATE app SET last_check_attempt = NOW() WHERE domain = ?
      `,
      [ domain ]
    );
    throw e;
  }
}

app.use((req, res, next) => {
  if (req.originalUrl.indexOf('/private') == 0) {
    const domain = getApiDomain(req);
    if (!domain) {
      return res.status(401).json({ error: 'Unauthorized - Invalid API Key' });
    }
    req.apiDomain = domain;
  }
  next();
});

app.get('/status', (req, res) => {
  jsonResponse(res, null, { status: "OK"});
});

app.get('/reload/app/:domain', async (req, res) => {
  const domain = req.params.domain || '';
  if (domain.length == 0) {
    jsonResponse(res, new Error('Missing domain'));
  } else {
    try {
      await syncApp(domain);
      jsonResponse(res, null, "OK");
    } catch (e) {
      jsonResponse(res, e);
    }
  }
});

app.get('/app/:domain', async (req, res) => {
  const domain = req.params.domain || '';
  try {
    if (domain.length == 0) {
      throw new Error("Missing domain");
    } else {
      const [results] = await pool.query(
        `
        SELECT *
        FROM app
        WHERE domain = ?
        `,
        [ domain ]
      );
      if (results.length == 0) {
        const frame = await syncApp(domain);
        jsonResponse(res, null, {
          domain,
          frame,
          ...getOnchainMetadata(domain),
        });
      } else {
        const r = results[0];
        jsonResponse(res, null, {
          domain: r.domain,
          frame: JSON.parse(r.frame_json),
          ...getOnchainMetadata(domain),
        });
      }
    }
  } catch (e) {
    jsonResponse(res, e, null);
  }
});

app.get('/apps', async (req, res) => {
  const numApps = await farstoreContract.getAppCounter();
  try {
    if (numApps > 0n) {
      const [domains, hidden] = await farstoreBatchReadContract.getDomainsAndHidden(1, numApps);
      const visibleDomains = domains.filter((d, i) => !hidden[i]);
      if (visibleDomains.length > 0) {
        const [results] = await pool.query(
          `
          SELECT *
          FROM app
          WHERE domain IN (${repeat('?', visibleDomains.length)})
          `,
          visibleDomains
        );
        jsonResponse(res, null, results.map(r => ({
          domain: r.domain,
          frame: JSON.parse(r.frame_json),
          ...getOnchainMetadata(r.domain),
        })));
      } else {
        jsonResponse(res, null, []);
      }
    } else {
      jsonResponse(res, null, []);
    }
  } catch (e) {
    jsonResponse(res, e, null);
  }
});

app.get('/onchain-metadata', async (req, res) => {
  jsonResponse(res, null, ONCHAIN_DATA_CACHE);
});

app.get('/private/notification_target/active', async (req, res) => {
  const [targets] = await pool.query(
    `
    SELECT *, endpoint AS url
    FROM notification_target
    WHERE domain = ? AND active = TRUE
    `,
    [ req.apiDomain ]
  );
  jsonResponse(res, null, targets);
});

app.get('/private/notification_target', async (req, res) => {
  const fid = req.query.fid || '-1';
  const [targets] = await pool.query(
    `
    SELECT *, endpoint AS url
    FROM notification_target
    WHERE fid = ? AND domain = ?
    `,
    [ fid, req.apiDomain ]
  );
  jsonResponse(res, null, targets.length > 0 ? targets[0] : null);
});

app.post('/private/notification_target', async (req, res) => {
  const { apiKey, fid, token, endpoint } = req.body;
  try {
    await pool.query(
      `
      INSERT INTO notification_target (domain, fid, endpoint, token)
      VALUES (?,?,?,?)
      ON DUPLICATE KEY UPDATE
        active = TRUE,
        token = VALUES(token)
      `,
      [ req.apiDomain, fid, endpoint, token ]
    );
    jsonResponse(res, null, 'OK');
  } catch (e) {
    jsonResponse(res, e);
  }
});

app.delete('/private/notification_target', async (req, res) => {
  const { fid } = req.body;
  try {
    await pool.query(
      `
      UPDATE notification_target
      SET active = FALSE
      WHERE fid = ? AND domain = ?
      `,
      [ fid, req.apiDomain ]
    );
    jsonResponse(res, null, 'OK');
  } catch (e) {
    jsonResponse(res, e);
  }
});

const resyncApps = async () => {
  const numApps = await farstoreContract.getAppCounter();
  const [domains, hidden] = await farstoreBatchReadContract.getDomainsAndHidden(1, numApps);
  for (let i = 0; i < domains.length; i++) {
    try {
      await syncApp(domains[i]);
    } catch (e) {
      console.log(`Unable to resync domain: ${domains[i]}`);
    }
  }
  console.log(`resynced ${domains.length} domains`);
}

const syncOnchainData = async () => {
  const results = [];
  const numApps = await farstoreContract.getAppCounter();
  for (let i = 1; i <= numApps; i++) {
    const { domain, token, owner, createTime } = await farstoreContract.getAppDestructured(i);
    const fundingWei = await launcherContract.getAppFunds(i);
    const funding = parseFloat(ethers.formatEther(fundingWei));
    if (token == '0x0000000000000000000000000000000000000000') {
      results.push({
        domain,
        owner,
        symbol: null,
        token: null,
        liquidity: 0.0,
        funding,
        createTime: Number(createTime)
      });
    } else {
      const tokenContract = new ethers.Contract(token, erc20Abi, provider);
      const symbol = await tokenContract.symbol();
      const liquidity = await getTokenEthLiquidity(token);
      results.push({
        domain,
        owner,
        symbol,
        token,
        liquidity,
        funding,
        createTime: Number(createTime)
      });
    }
  }
  ONCHAIN_DATA_CACHE = {};
  for (let i = 0; i < results.length; i++) {
    ONCHAIN_DATA_CACHE[results[i].domain] = results[i];
  }
}

const reloadApiKeys = async () => {
  const [results] = await pool.query('SELECT * FROM app_api_key');
  API_DOMAIN_CACHE = {};
  results.forEach(r => API_DOMAIN_CACHE[r.api_key] = r.domain);
}

const CRON_MIN = '* * * * *';
const CRON_2MIN = '*/2 * * * *';
schedule.scheduleJob(CRON_2MIN, resyncApps);
schedule.scheduleJob(CRON_2MIN, reloadApiKeys);
schedule.scheduleJob(CRON_MIN, syncOnchainData);

resyncApps();
reloadApiKeys();
syncOnchainData();

app.listen(port, () => {
  console.log(`Listening on ${port}`);
});
