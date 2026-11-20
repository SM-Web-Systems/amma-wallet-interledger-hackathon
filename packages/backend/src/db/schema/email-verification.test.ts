import {describe,it,expect} from 'vitest';
import {getTableConfig} from 'drizzle-orm/pg-core';
import {getTableName} from 'drizzle-orm';
import * as schema from './index';
import {generateDrizzleJson,generateMigration} from 'drizzle-kit/api';

describe('fresh Wallet schema supports real email verification handlers',()=>{
 it('declares the raw SQL verification-token contract used by registration, verification and resend',()=>{
  expect(schema).toHaveProperty('emailVerificationTokens');
  const table=schema.emailVerificationTokens;
  const definition=getTableConfig(table);
  expect(definition.name).toBe('email_verification_tokens');
  expect(definition.columns.map(column=>column.name)).toEqual(expect.arrayContaining(['id','user_id','token','expires_at','used_at','created_at','email']));
  expect(table.id.primary).toBe(true);
  expect(table.token.notNull).toBe(true);
  expect(table.token.isUnique).toBe(true);
  expect(table.userId.notNull).toBe(true);
  expect(table.expiresAt.notNull).toBe(true);
  expect(table.usedAt.notNull).toBe(false);
  expect(table.email.notNull).toBe(false);
  const key=definition.foreignKeys.find(key=>key.reference().columns.includes(table.userId));
  expect(key).toBeDefined();
  expect(getTableName(key!.reference().foreignTable)).toBe('users');
  expect(key!.onDelete).toBe('cascade');
 });
 it('exports additive verification-table DDL without changing existing modeled tables',async()=>{
  const {emailVerificationTokens,...before}=schema;
  const previous=generateDrizzleJson(before);
  const statements=await generateMigration(previous,generateDrizzleJson(schema,previous.id));
  expect(statements).toHaveLength(2);
  expect(statements[0]).toMatch(/^CREATE TABLE "email_verification_tokens"/);
  expect(statements[1]).toMatch(/^ALTER TABLE "email_verification_tokens"/);
  expect(statements[1]).toMatch(/REFERENCES.*"users"/);
  expect(statements.join('\n')).not.toMatch(/DROP TABLE|TRUNCATE|DELETE FROM/);
 });
});
