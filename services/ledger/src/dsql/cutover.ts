import { smokeNativeExceptions } from './exception-smoke.js';
import { smokeNativeThreads } from './thread-smoke.js';
import { smokeNativeDeliveries } from './delivery-smoke.js';
import { smokeNativePush } from './push-smoke.js';
import { createPool } from './connection.js';
import { readStorageAuthority } from './sql-runtime.js';
import { smokeNativeLedger } from './ledger-smoke.js';
import { smokeNativeWealth } from './wealth-smoke.js';
import { createHash, randomUUID } from 'node:crypto';

// Internal IAM-only deployed operator. Product identities cannot update authority.
// Activation is allowed only by the approved cutover rollout's environment flag.
export const cutoverHandler=async (event:{action:'status'|'pause'|'activate'|'smoke'}):Promise<Record<string,unknown>> => {
  const pool=createPool('olbia_cutover');
  try {
    if(event.action==='status') return {mode:await readStorageAuthority(pool)};
    if(event.action==='smoke') {
      const rollback=new Error('Smoke rollback');let verified=false;
      try {await pool.transaction(async client=>{
        await client.query("UPDATE olbia.application_barrier SET generation=generation+1 WHERE id='storage'");
        const category = (await client.query('SELECT id,name,sort_order FROM olbia.spend_categories ORDER BY id LIMIT 1')).rows[0];
        if (!category) throw new Error('No native catalog category for smoke');
        const nativeCategory = (await client.query(`INSERT INTO olbia.spend_categories (id,name,sort_order) VALUES ($1,$2,$3)
          ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name,sort_order=EXCLUDED.sort_order RETURNING id`,
        [category.id, 'SQL verification', category.sort_order])).rows[0];
        if (nativeCategory?.id !== category.id) throw new Error('Native catalog upsert failed');
        const rule = (await client.query('SELECT merchant_key,id FROM olbia.merchant_rules ORDER BY merchant_key LIMIT 1')).rows[0];
        if (rule) {
          const nativeRule = (await client.query(`INSERT INTO olbia.merchant_rules
            (merchant_key,id,pattern,category_id,source,updated_at) VALUES ($1,$2,NULL,$3,'human',CURRENT_TIMESTAMP)
            ON CONFLICT (merchant_key) DO UPDATE SET category_id=EXCLUDED.category_id RETURNING id,category_id`,
          [rule.merchant_key, rule.id, category.id])).rows[0];
          if (nativeRule?.id !== rule.id || nativeRule.category_id !== category.id) throw new Error('Native rule upsert failed');
        }
        const card = (await client.query('SELECT * FROM olbia.card_profiles WHERE deleted_at IS NULL ORDER BY id LIMIT 1')).rows[0];
        if (!card) throw new Error('No native profile for smoke');
        const updated = (await client.query(`INSERT INTO olbia.card_profiles
          (id,owner,name,cut_off_day,payment_due_day,institution,created_at,updated_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name RETURNING id,name`,
        [card.id,card.owner,'SQL verification',card.cut_off_day,card.payment_due_day,card.institution,card.created_at,card.updated_at])).rows[0];
        if (updated?.id !== card.id || updated.name !== 'SQL verification') throw new Error('Native profile upsert failed');
        const retained = (await client.query(`SELECT count(*) AS count FROM olbia.liability_captures WHERE card_id=$1`, [card.id])).rows[0]?.count;
        await client.query('UPDATE olbia.card_profiles SET deleted_at=CURRENT_TIMESTAMP WHERE id=$1', [card.id]);
        if ((await client.query('SELECT id FROM olbia.card_profiles WHERE id=$1 AND deleted_at IS NULL', [card.id])).rows.length) throw new Error('Inactive profile was visible');
        const stillRetained = (await client.query(`SELECT count(*) AS count FROM olbia.liability_captures WHERE card_id=$1`, [card.id])).rows[0]?.count;
        if (String(retained) !== String(stillRetained)) throw new Error('Profile removal changed liability history');
        await client.query('UPDATE olbia.card_profiles SET deleted_at=NULL WHERE id=$1', [card.id]);
        const plan = (await client.query('SELECT month,owner FROM olbia.month_plans ORDER BY month LIMIT 1')).rows[0];
        if (!plan) throw new Error('No native month plan for smoke');
        const upserted = (await client.query(`INSERT INTO olbia.month_plans (month,owner,updated_at) VALUES ($1,$2,CURRENT_TIMESTAMP)
          ON CONFLICT (month) DO UPDATE SET updated_at=EXCLUDED.updated_at RETURNING month`, [plan.month,plan.owner])).rows[0];
        if (upserted?.month !== plan.month) throw new Error('Native plan upsert failed');
        await client.query('DELETE FROM olbia.planned_payments WHERE month=$1', [plan.month]);
        await client.query(`INSERT INTO olbia.planned_payments (month,id,name,amount_mxn_minor,due_day,sort_order)
          VALUES ($1,'sql-verification','SQL verification',1,31,0)`, [plan.month]);
        const child = (await client.query('SELECT id,amount_mxn_minor FROM olbia.planned_payments WHERE month=$1', [plan.month])).rows[0];
        if (child?.id !== 'sql-verification' || Number(child.amount_mxn_minor) !== 1) throw new Error('Native payment replacement failed');
        await client.query('DELETE FROM olbia.planned_payments WHERE month=$1', [plan.month]);
        if (!(await client.query('SELECT month FROM olbia.month_plans WHERE month=$1', [plan.month])).rows.length) throw new Error('Empty plan parent lost');
        const receipt = (await client.query('SELECT uuid FROM olbia.payslips ORDER BY uuid LIMIT 1')).rows[0];
        if (!receipt) throw new Error('No native payslip for smoke');
        const smokeUuid = randomUUID();
        const copyReceipt = `INSERT INTO olbia.payslips (uuid,owner,paid_on,payroll_type,total_mxn_minor,perceptions_mxn_minor,
          deductions_mxn_minor,other_payments_mxn_minor,employer_name,pay_period_start,pay_period_end,ingested_at,
          evidence_bucket,evidence_key,evidence_sha256,evidence_content_type)
          SELECT $1::uuid,owner,paid_on,payroll_type,total_mxn_minor,perceptions_mxn_minor,deductions_mxn_minor,
            other_payments_mxn_minor,employer_name,pay_period_start,pay_period_end,ingested_at,evidence_bucket,evidence_key,
            evidence_sha256,evidence_content_type FROM olbia.payslips WHERE uuid=$2::uuid
          ON CONFLICT (uuid) DO NOTHING RETURNING uuid`;
        if ((await client.query(copyReceipt,[smokeUuid,receipt.uuid])).rows[0]?.uuid !== smokeUuid) throw new Error('Native payslip insertion failed');
        if ((await client.query(copyReceipt,[smokeUuid,receipt.uuid])).rows.length) throw new Error('Duplicate native payslip changed');
        await client.query(`INSERT INTO olbia.payslip_lines (payslip_uuid,position,sat_kind,sat_type,code,concept,amount_mxn_minor)
          VALUES ($1::uuid,0,'otro_pago','002','','',0)`,[smokeUuid]);
        const zeroLine = (await client.query('SELECT amount_mxn_minor FROM olbia.payslip_lines WHERE payslip_uuid=$1::uuid',[smokeUuid])).rows[0];
        if (Number(zeroLine?.amount_mxn_minor) !== 0) throw new Error('Native zero payroll line lost');
        const importSource = (await client.query('SELECT * FROM olbia.bank_imports ORDER BY kind,content_sha256 LIMIT 1')).rows[0];
        if (!importSource) throw new Error('No native import for smoke');
        const smokeHash = createHash('sha256').update(randomUUID()).digest('hex');
        const insertImport = `INSERT INTO olbia.bank_imports
          (kind,content_sha256,owner,status,created_at,previewed_at,account_last_four,evidence_bucket,evidence_key,evidence_content_type)
          VALUES ('santander_csv',$1,$2,'previewed',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,$3,$4,$5,'text/csv')
          ON CONFLICT (kind,content_sha256) DO NOTHING RETURNING content_sha256`;
        const importValues = [smokeHash,importSource.owner,importSource.account_last_four,importSource.evidence_bucket,importSource.evidence_key];
        if ((await client.query(insertImport,importValues)).rows[0]?.content_sha256 !== smokeHash) throw new Error('Native import insertion failed');
        if ((await client.query(insertImport,importValues)).rows.length) throw new Error('Duplicate native import changed');
        await client.query(`INSERT INTO olbia.bank_import_rows
          (kind,content_sha256,position,identity,occurred_on,merchant_raw,amount_mxn_minor,status)
          VALUES ('santander_csv',$1,0,'verification-zero','2026-01-01','SQL verification',0,'matched'),
          ('santander_csv',$1,1,'verification-credit','2026-01-02','SQL verification',-1,'excluded')`,[smokeHash]);
        await client.query(`INSERT INTO olbia.bank_import_candidates
          (kind,content_sha256,row_position,position,movement_id,merchant_raw)
          VALUES ('santander_csv',$1,0,0,'historical-verification',NULL)`,[smokeHash]);
        const importedRows = (await client.query(`SELECT position,amount_mxn_minor FROM olbia.bank_import_rows
          WHERE kind='santander_csv' AND content_sha256=$1 ORDER BY position`,[smokeHash])).rows;
        if (importedRows.length !== 2 || Number(importedRows[0].amount_mxn_minor) !== 0 || Number(importedRows[1].amount_mxn_minor) !== -1) throw new Error('Native signed import rows lost');
        await client.query("DELETE FROM olbia.bank_import_candidates WHERE kind='santander_csv' AND content_sha256=$1",[smokeHash]);
        await client.query("DELETE FROM olbia.bank_import_rows WHERE kind='santander_csv' AND content_sha256=$1",[smokeHash]);
        const finishedImport = (await client.query(`UPDATE olbia.bank_imports SET status='applied',applied_at=CURRENT_TIMESTAMP,
          result_created=0,result_linked=0,result_skipped=2 WHERE kind='santander_csv' AND content_sha256=$1 RETURNING status,result_skipped`,[smokeHash])).rows[0];
        if (finishedImport?.status !== 'applied' || finishedImport.result_skipped !== 2) throw new Error('Native import completion failed');
        await smokeNativeLedger(client, String(importSource.owner), String(category.id));
        await smokeNativeWealth(client, String(importSource.owner), String(card.id));
        await smokeNativePush(client, String(importSource.owner));
        await smokeNativeDeliveries(client, String(importSource.owner));
        await smokeNativeThreads(client, String(importSource.owner));
        await smokeNativeExceptions(client,String(importSource.owner));
        verified=true;throw rollback;
      });} catch(error) {if(error!==rollback) throw error;}
      return {verified,rolledBack:true,nativeCategories:true,nativeCards:true,nativeMonthPlans:true,nativePayroll:true,nativeImports:true,nativeLedger:true,nativeWealth:true,nativePush:true,nativeDeliveries:true,nativeThreads:true,nativeExceptions:true};
    }
    if(!['pause','activate'].includes(event.action)) throw new Error('Unknown operation');
    if(event.action==='activate' && process.env.OLBIA_ALLOW_SQL_ACTIVATION!=='true') throw new Error('SQL activation requires the approved cutover deployment');
    return await pool.transaction(async client=>{
      await client.query("UPDATE olbia.application_barrier SET generation=generation+1 WHERE id='storage'");
      const previous=await readStorageAuthority(client);
      if(event.action==='pause' && previous==='sql') return {mode:previous}; // subsequent deployments do not pause an established SQL system
      if(event.action==='activate' && !['paused','sql'].includes(previous)) throw new Error('Pause required before activation');
      const mode=event.action==='pause'?'paused':'sql';
      await client.query("UPDATE olbia.runtime_state SET mode=$1,changed_at=CURRENT_TIMESTAMP WHERE id='storage'",[mode]);
      return {mode};
    });
  } catch {throw new Error('DSQL cutover operation failed; authority retained.');}
  finally {await pool.end();}
};
