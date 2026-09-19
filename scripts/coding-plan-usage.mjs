#!/usr/bin/env node
/**
 * 查询火山方舟 Coding Plan / Agent Plan 订阅与用量状况（官方管理 OpenAPI）
 *
 * 接口依据（火山方舟文档 82379）：
 *   - GetPersonalPlan : 查询个人版套餐（套餐类型、状态、生效/到期时间、自动续费）
 *     https://www.volcengine.com/docs/82379/2546382
 *   - GetUsageDetails : 获取套餐模型调用量明细（当前文档标注为 Agent Plan 用，Coding Plan 未承诺支持）
 *     https://www.volcengine.com/docs/82379/2479849
 *   - ListArkCodingPlanModel : 查询 Coding Plan 支持的模型列表
 *     https://www.volcengine.com/docs/82379/2546386
 *
 * 鉴权：火山引擎 OpenAPI v4（HMAC-SHA256，AK/SK），Host: open.volcengineapi.com
 * 凭据来源（按优先级）：命令行 --ak/--sk > 环境变量 VOLC_ACCESSKEY/VOLC_SECRETKEY > 环境变量 ARK_AK/ARK_SK
 *
 * 用法：
 *   node coding-plan-usage.mjs [--ak AK] [--sk SK] [--plan CodingPlan|AgentPlan] [--usage] [--raw]
 * 示例：
 *   node coding-plan-usage.mjs --ak AKLTxxx --sk skxxx
 *   node coding-plan-usage.mjs --usage --plan AgentPlan
 */
import { createHash, createHmac } from "node:crypto";

const HOST = "open.volcengineapi.com";
const REGION = "cn-beijing";
const SERVICE = "ark";
const VERSION = "2024-01-01";

function sha256Hex(s) {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

function hmac(key, s) {
  return createHmac("sha256", key).update(s, "utf8").digest();
}

/**
 * 火山引擎 OpenAPI v4 签名
 * 与 AWS SigV4 同构，但初始密钥直接使用 SecretKey（无 "AWS4"/"ARK" 前缀）
 * 参考官方实现：https://github.com/volcengine/volcengine-go-sdk/blob/master/volcengine/base/sign.go
 */
function signRequest({ ak, sk, method, uri, query, body, xDate }) {
  const canonicalUri = uri || "/";
  const canonicalQuery = Object.keys(query)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(query[k])}`)
    .join("&");
  const hashedPayload = sha256Hex(body || "");
  const canonicalHeaders =
    `host:${HOST}\n` + `x-content-sha256:${hashedPayload}\n` + `x-date:${xDate}\n`;
  const signedHeaders = "host;x-content-sha256;x-date";
  const canonicalRequest = [
    method,
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    hashedPayload,
  ].join("\n");

  const date = xDate.slice(0, 8);
  const scope = `${date}/${REGION}/${SERVICE}/request`;
  const stringToSign = ["HMAC-SHA256", xDate, scope, sha256Hex(canonicalRequest)].join("\n");

  const kDate = hmac(sk, date);
  const kRegion = hmac(kDate, REGION);
  const kService = hmac(kRegion, SERVICE);
  const kSigning = hmac(kService, "request");
  const signature = hmac(kSigning, stringToSign).toString("hex");

  return {
    Authorization:
      `HMAC-SHA256 Credential=${ak}/${scope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`,
    "X-Content-Sha256": hashedPayload,
    "X-Date": xDate,
  };
}

async function callArk(action, ak, sk, body, extraQuery = {}) {
  const xDate = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const query = { Action: action, Version: VERSION, ...extraQuery };
  const payload = body === undefined ? "" : JSON.stringify(body);
  const headers = signRequest({
    ak,
    sk,
    method: "POST",
    uri: "/",
    query,
    body: payload,
    xDate,
  });
  const url = `https://${HOST}/?${new URLSearchParams(query)}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      ...headers,
      "Content-Type": "application/json; charset=UTF-8",
      Host: HOST,
    },
    body: payload || undefined,
  });
  const text = await resp.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { status: resp.status, json };
}

function getCredentials(args) {
  const ak = args.ak || process.env.VOLC_ACCESSKEY || process.env.ARK_AK || "";
  const sk = args.sk || process.env.VOLC_SECRETKEY || process.env.ARK_SK || "";
  return { ak, sk };
}

function fmtTime(iso) {
  if (!iso) return "-";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
}

function daysLeft(iso) {
  if (!iso) return null;
  const end = new Date(iso).getTime();
  if (Number.isNaN(end)) return null;
  return Math.ceil((end - Date.now()) / 86400000);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--ak") args.ak = argv[++i];
    else if (a === "--sk") args.sk = argv[++i];
    else if (a === "--plan") args.plan = argv[++i];
    else if (a === "--usage") args.usage = true;
    else if (a === "--raw") args.raw = true;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { ak, sk } = getCredentials(args);
  if (!ak || !sk) {
    console.error(
      "缺少访问密钥。请提供火山引擎 AK/SK：\n" +
        "  node coding-plan-usage.mjs --ak <AccessKeyId> --sk <SecretAccessKey>\n" +
        "或设置环境变量 VOLC_ACCESSKEY / VOLC_SECRETKEY（或 ARK_AK / ARK_SK）。\n" +
        "获取方式：控制台右上角头像 -> 密钥管理（或访问 https://console.volcengine.com/iam/keymanage ）",
    );
    process.exit(2);
  }
  const plan = args.plan || "CodingPlan";

  // 1. 查询订阅状态
  const { status, json } = await callArk("GetPersonalPlan", ak, sk, { Plan: plan });
  if (args.raw) console.log(JSON.stringify(json, null, 2));
  const err = json?.ResponseMetadata?.Error;
  if (err || status >= 400) {
    if (err?.Code === "ResourceNotFound.Plan") {
      console.log(`当前账号没有有效的 ${plan} 订阅（或套餐已过期）。`);
    } else {
      console.error(
        `查询失败 HTTP ${status}: ${err?.Code || ""} ${err?.Message || json?.raw || ""}`,
      );
      if (/Signature|Credential|AccessKey|auth/i.test(JSON.stringify(err) + (json?.raw || ""))) {
        console.error("提示：请检查 AK/SK 是否正确，以及账号是否有 ark 服务访问权限。");
      }
      process.exit(1);
    }
  } else {
    const r = json?.Result || {};
    const planName = plan === "CodingPlan" ? "Coding Plan" : "Agent Plan";
    console.log(`=== ${planName} 订阅状态 ===`);
    console.log(
      `套餐档位     : ${r.PlanType || "-"}  (CodingPlan: Lite/Pro; AgentPlan: Small/Medium/Large/Max)`,
    );
    console.log(`状态         : ${r.Status || "-"}  (Running=有效, Expired=已过期)`);
    console.log(`生效时间     : ${fmtTime(r.StartTime)}`);
    console.log(`到期时间     : ${fmtTime(r.EndTime)}`);
    const dl = daysLeft(r.EndTime);
    if (dl !== null)
      console.log(
        `剩余天数     : ${dl >= 0 ? dl : 0} 天${r.AutoRenew ? "（已开启自动续费）" : ""}`,
      );
    console.log(`自动续费     : ${r.AutoRenew === true ? "是" : "否"}`);
  }

  // 2. 可选：查询用量明细（当前仅 Agent Plan 有文档承诺；CodingPlan 视服务端支持而定）
  if (args.usage) {
    const end = new Date();
    const start = new Date(end.getTime() - 30 * 86400000);
    const iso = (d) => d.toISOString().slice(0, 10);
    const body = {
      QueryInterval: "Day",
      Filter: {
        StartTime: iso(start),
        EndTime: iso(end),
        PlanType: plan === "CodingPlan" ? ["Lite", "Pro"] : ["Small", "Medium", "Large", "Max"],
      },
    };
    const { status: s2, json: j2 } = await callArk("GetUsageDetails", ak, sk, body);
    const err2 = j2?.ResponseMetadata?.Error;
    if (err2 || s2 >= 400) {
      console.log(`\n用量明细查询未成功（HTTP ${s2}）: ${err2?.Code || ""} ${err2?.Message || ""}`);
      console.log(
        "提示：GetUsageDetails 当前文档标注为 Agent Plan 接口；Coding Plan 剩余额度请在控制台查看。",
      );
    } else {
      const details = j2?.Result?.Details || [];
      const within = details
        .filter((d) => d.BillingType === "WithinPlan")
        .reduce((s, d) => s + (d.Usage || 0), 0);
      const outside = details
        .filter((d) => d.BillingType === "OutsideOfPlan")
        .reduce((s, d) => s + (d.Usage || 0), 0);
      console.log(`\n=== 近 30 天用量明细 ===`);
      console.log(`套餐内已用   : ${within.toLocaleString()} Tokens`);
      console.log(`套餐外已用   : ${outside.toLocaleString()} Tokens`);
      console.log(`明细条数     : ${details.length}`);
      if (args.raw) console.log(JSON.stringify(j2, null, 2));
    }
  }
}

main().catch((e) => {
  console.error("执行出错:", e.message);
  process.exit(1);
});
