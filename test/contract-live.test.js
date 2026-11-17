// Runs the contract suite against the REAL Moneypenny. Skipped unless MNP_LIVE=1. Use a Moneypenny TEST tenant.
import { test } from 'node:test';
import { contractSuite } from './contract.js';
import { MoneypennyProvider } from '../src/provider/moneypenny.js';

const live = process.env.MNP_LIVE === '1';
contractSuite((name, fn) => test('LIVE moneypenny: ' + name, { skip: !live && 'set MNP_LIVE=1 with MNP_BASE_URL, MNP_KEY_ID, MNP_SECRET' }, fn),
  async () => new MoneypennyProvider({ baseUrl: process.env.MNP_BASE_URL, keyId: process.env.MNP_KEY_ID, secret: process.env.MNP_SECRET }));
