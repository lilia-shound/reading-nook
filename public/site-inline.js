/*!
 * site-inline.js —— 由 tools/gen-site.js 生成，**别手改**
 *
 * 站点配置的「随身副本」：让浏览器启动时不必先去网络拿 site.json
 *（Pages 的 CDN 会抖，一抖就整个站点开不了门）
 *
 * 改了配置就重新跑 `node tools/gen-site.js`，然后 `node tools/push-repo.js --site`
 */
window.NOOK_SITE = {
  "mode": "static",
  "owner": "lilia-shound",
  "repo": "reading-nook",
  "branch": "main",
  "kdf": {
    "algo": "PBKDF2-SHA256",
    "iter": 210000,
    "salt": "z9oA24U9ra9hy1vNjymZfg=="
  },
  "names": {
    "user": "姜来",
    "ai": "姜去"
  },
  "subtitle": "姜来 & 姜去",
  "login_hint": "两个人的生日相加",
  "static_only": [
    "upload",
    "notes",
    "workbench",
    "settings-server",
    "ai-auto"
  ],
  "updatedAt": "2026-10-22T11:19:19.634Z"
};
