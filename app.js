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
const uniswapV3FactoryAbi = require('./abi/uniswap-v3-factory.json');
const erc20Abi = require('./abi/erc-20.json');

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
const uniswapV3FactoryContract = new ethers.Contract(UNISWAP_V3_FACTORY, uniswapV3FactoryAbi, provider);
const wethContract = new ethers.Contract(WETH, erc20Abi, provider);

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

let LIQUIDITY_CACHE = {};
let API_DOMAIN_CACHE = {};

function getApiDomain(req) {
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.split(' ')[1];
  return API_DOMAIN_CACHE[token];
}

function getToken(frameId) {
  return LIQUIDITY_CACHE[frameId] || {
    token: null,
    liquidity: 0.0,
  }
}

async function reloadFrame(rawDomain) {
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
    let frameId = (await farstoreContract.getId(domain)) || null;
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
      INSERT INTO app (frame_id, domain, frame_json, last_check_attempt, last_check_success)
      VALUES (?,?,?,NOW(),NOW())
      ON DUPLICATE KEY UPDATE
        frame_id = VALUES(frame_id),
        frame_json = VALUES(frame_json),
        last_check_attempt = NOW(),
        last_check_success = NOW()
      `,
      [ frameId, domain, JSON.stringify(json.frame) ]
    );
    return {
      frameId: frameId,
      frame: json.frame,
    }
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
      await reloadFrame(domain);
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
        const { frame, frameId } = await reloadFrame(domain);
        jsonResponse(res, null, {
          domain,
          frame,
          frameId,
          ...getToken(frameId),
        });
      } else {
        const r = results[0];
        jsonResponse(res, null, {
          domain: r.domain,
          frameId: r.frame_id,
          frame: JSON.parse(r.frame_json),
          ...getToken(r.frame_id),
        });
      }
    }
  } catch (e) {
    jsonResponse(res, e, null);
  }
});

app.get('/apps', async (req, res) => {
  const frameIds = req.query.frameIds ? req.query.frameIds.split(',') : [];
  try {
    if (frameIds.length == 0) {
      const [results] = await pool.query(
        `
        SELECT *
        FROM app
        WHERE frame_id IS NOT NULL
        `,
      );
      jsonResponse(res, null, results.map(r => ({
        domain: r.domain,
        frameId: r.frame_id,
        frame: JSON.parse(r.frame_json),
        ...getToken(r.frame_id),
      })));
    } else if (frameIds.length > 20) {
      throw new Error("Max 20 frameIds");
    } else {
      const [results] = await pool.query(
        `
        SELECT *
        FROM app
        WHERE frame_id IN (${repeat('?', frameIds.length)})
        `,
        frameIds
      );
      jsonResponse(res, null, results.map(r => ({
        domain: r.domain,
        frameId: r.frame_id,
        frame: JSON.parse(r.frame_json),
        ...getToken(r.frame_id),
      })));
    }
  } catch (e) {
    jsonResponse(res, e, null);
  }
});

app.get('/tokens', async (req, res) => {
  jsonResponse(res, null, LIQUIDITY_CACHE);
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

const syncApps = async () => {
  const chainMax = await farstoreContract.getNumListedFrames();
  const [result] = await pool.query('SELECT COALESCE(MAX(frame_id), 0) AS dbMax FROM app');
  const dbMax = result[0].dbMax;
  for (let i = dbMax + 1; i <= Number(chainMax); i++) {
    const domain = await farstoreContract.getDomain(i);
    await reloadFrame(domain);
  }
}

const resyncApps = async () => {
  const chainMax = await farstoreContract.getNumListedFrames();
  const [result] = await pool.query(
    `
    SELECT frame_id
    FROM app
    WHERE frame_id IS NOT NULL
    ORDER BY last_check_attempt ASC
    LIMIT 10
    `
  );
  for (let i = 0; i < result.length; i++) {
    const domain = await farstoreContract.getDomain(result[i].frame_id);
    try {
      await reloadFrame(domain);
    } catch (e) {
      console.log(`Unable to resync domain: ${domain}`);
    }
  }
}

const syncLiquidity = async () => {
  const results = [];
  const tokens = await farstoreContract.getListedTokens();
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const frameId = Number(await farstoreContract.getTokenFrame(token));
    const pool = await uniswapV3FactoryContract.getPool(token, WETH, 10000);
    const liquidity = parseFloat(ethers.formatEther((await wethContract.balanceOf(pool)).toString()));
    results.push({
      frameId,
      token,
      liquidity,
    });
  }
  LIQUIDITY_CACHE = {};
  for (let i = 0; i < results.length; i++) {
    LIQUIDITY_CACHE[results[i].frameId] = results[i];
  }
}

const reloadApiKeys = async () => {
  const [results] = await pool.query('SELECT * FROM app_api_key');
  API_DOMAIN_CACHE = {};
  results.forEach(r => API_DOMAIN_CACHE[r.api_key] = r.domain);
}

const CRON_MIN = '* * * * *';
schedule.scheduleJob(CRON_MIN, syncApps);
schedule.scheduleJob(CRON_MIN, resyncApps);
schedule.scheduleJob(CRON_MIN, reloadApiKeys);
schedule.scheduleJob(CRON_MIN, syncLiquidity);

syncApps();
resyncApps();
reloadApiKeys();
syncLiquidity();

app.listen(port, () => {
  console.log(`Listening on ${port}`);
});
