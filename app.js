import express from 'express';
import mysql from 'mysql2/promise';
import helmet from 'helmet';
import cors from 'cors';
import bodyParser from 'body-parser';
import { ethers } from 'ethers';
import dotenv from 'dotenv';
import path from 'path';
import schedule from 'node-schedule';
import { v4 } from 'uuid';
import fetch from 'node-fetch';
import { dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);  // Get the full file path
const __dirname = dirname(__filename);  // Get the directory path

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
  origin: [
    process.env.APP_URL,
  ],
  optionsSuccessStatus: 200 // some legacy browsers (IE11, various SmartTVs) choke on 204
}));

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
// app.use(express.static('build'));

app.use((req, res, next) => {
  if (req.originalUrl.indexOf('/v1') == 0) {
    // Get the Authorization header
    const authHeader = req.headers['authorization'];
    // Check if it exists and starts with 'Bearer '
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Unauthorized - Missing API Key' });
    }

    // Extract the token (remove 'Bearer ' prefix)
    const token = authHeader.split(' ')[1];
    if (token != process.env.APP_API_KEY) {
      return res.status(401).json({ error: 'Unauthorized - Invalid API Key' });
    }
  }
  next();
});

app.get('/status', (req, res) => {
  jsonResponse(res, null, { status: "OK"});
});

app.get('/v1/notification_target', async (req, res) => {
  // const contractAddress = (req.query.contractAddress || '').toLowerCase();
  const fid = req.query.fid || '-1';
  const [targets] = await pool.query(
    `
    SELECT * FROM notification_target WHERE fid = ?
    `,
    [ fid ]
  );
  jsonResponse(res, null, targets.length > 0 ? targets[0] : null);
});

app.post('/v1/notification_target', async (req, res) => {
  const { fid, token, url } = req.body;
  try {
    await pool.query(
      `
      INSERT INTO notification_target (fid, url, token) VALUES (?,?,?)
      ON DUPLICATE KEY UPDATE
        active = TRUE,
        token = VALUES(token)
      `,
      [ fid, url, token ]
    );
    jsonResponse(res, null, 'OK');
  } catch (e) {
    jsonResponse(res, e);
  }
});

app.delete('/v1/notification_target', async (req, res) => {
  const { fid } = req.body;
  try {
    await pool.query(
      `
      UPDATE notification_target SET active = FALSE WHERE fid = ?
      `,
      [ fid ]
    );
    jsonResponse(res, null, 'OK');
  } catch (e) {
    jsonResponse(res, e);
  }
});

const CRON_MIN = '* * * * *';
// schedule.scheduleJob(CRON_MIN, fn);

app.listen(port, () => {
  console.log(`Listening on ${port}`);
});