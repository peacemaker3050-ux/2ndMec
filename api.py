import os
import json
import uuid
import asyncio
import threading
import time
import sqlite3
from datetime import datetime
import os
os.environ['TZ'] = 'Africa/Cairo'
try:
    import time as _time
    _time.tzset()
except:
    pass
from flask import Flask, request, jsonify
from flask_cors import CORS

import firebase_admin
from firebase_admin import credentials, messaging, auth as firebase_auth
import aiohttp
from urllib.parse import quote

# Google Drive
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build
from googleapiclient.http import MediaIoBaseUpload
import io

# ==========================================
# 1. Config
# ==========================================
FIREBASE_DB_URL = "https://libirary-b2424-default-rtdb.firebaseio.com"
DEFAULT_SCOPE_KEY = "ميكانيكا__second__term2"
DRIVE_FOLDER_ID = "1T0MwUb-dc3UN3hMjrio1GVT6lm1mQl4Q"

# Google Drive OAuth credentials (from bot.py)
CLIENT_ID     = '1006485502608-ok2u5i6nt6js64djqluithivsko4mnom.apps.googleusercontent.com'
CLIENT_SECRET = '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'
REFRESH_TOKEN = '1//03rBdYnjPptutCgYIARAAGAMSNwF-L9IrQdCoaaWtNHykuevaFyU2BIgZx_xgfy6NmuNo7UVCb4uluy-f6K3utU6LFZvJpVMSZUE'

RAILWAY_URL = "https://web-production-f5fa0.up.railway.app"

# ==========================================
# 2. Firebase init
# ==========================================
try:
    sa_json = os.environ.get("SERVICE_ACCOUNT_JSON")
    if sa_json:
        sa_dict = json.loads(sa_json)
        cred = credentials.Certificate(sa_dict)
    else:
        cred = credentials.Certificate("service-account.json")
    if not firebase_admin._apps:
        firebase_admin.initialize_app(cred)
    print("✅ Firebase initialized")
except Exception as e:
    print(f"❌ Firebase Init Error: {e}")

# ==========================================
# 3. Google Drive init
# ==========================================
SCOPES = ['https://www.googleapis.com/auth/drive']
drive_credentials = Credentials(
    token=None,
    refresh_token=REFRESH_TOKEN,
    token_uri="https://oauth2.googleapis.com/token",
    client_id=CLIENT_ID,
    client_secret=CLIENT_SECRET,
    scopes=SCOPES
)

def get_drive_service():
    try:
        import httplib2
        from google_auth_httplib2 import AuthorizedHttp
        http = httplib2.Http()
        authorized_http = AuthorizedHttp(drive_credentials, http=http)
        return build('drive', 'v3', http=authorized_http)
    except ImportError:
        return build('drive', 'v3', credentials=drive_credentials)

# ==========================================
# 4. Flask App
# ==========================================
app_flask = Flask(__name__)
CORS(app_flask, origins=["https://peacemaker3050-ux.github.io", "https://claude.ai"], supports_credentials=True)

# ==========================================
# 4.5 Chat DB (Scope-Isolated, non-Firebase)
# ==========================================
CHAT_DB_PATH = os.environ.get("CHAT_DB_PATH", "chat.db")

def get_chat_conn():
    conn = sqlite3.connect(CHAT_DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    return conn

def init_chat_db():
    conn = get_chat_conn()
    cur = conn.cursor()
    cur.execute("""
        CREATE TABLE IF NOT EXISTS chat_members (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            scope_key TEXT NOT NULL,
            phone TEXT NOT NULL,
            name TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            UNIQUE(scope_key, phone)
        )
    """)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS chat_messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            scope_key TEXT NOT NULL,
            group_id TEXT NOT NULL,
            sender_name TEXT NOT NULL,
            sender_phone TEXT NOT NULL,
            message_type TEXT NOT NULL,
            message_text TEXT,
            media_url TEXT,
            created_at INTEGER NOT NULL
        )
    """)
    cur.execute("CREATE INDEX IF NOT EXISTS idx_chat_messages_scope_group_time ON chat_messages(scope_key, group_id, created_at DESC)")
    cur.execute("""
        CREATE TABLE IF NOT EXISTS chat_reactions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            scope_key TEXT NOT NULL,
            group_id TEXT NOT NULL,
            message_id INTEGER NOT NULL,
            phone TEXT NOT NULL,
            reaction TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            UNIQUE(scope_key, group_id, message_id, phone)
        )
    """)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS chat_group_settings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            scope_key TEXT NOT NULL,
            group_id TEXT NOT NULL,
            is_locked INTEGER NOT NULL DEFAULT 0,
            updated_by TEXT,
            updated_at INTEGER NOT NULL,
            UNIQUE(scope_key, group_id)
        )
    """)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS chat_reads (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            scope_key TEXT NOT NULL,
            group_id TEXT NOT NULL,
            message_id INTEGER NOT NULL,
            phone TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            UNIQUE(scope_key, group_id, message_id, phone)
        )
    """)
    conn.commit()
    conn.close()

init_chat_db()

# ==========================================
# 5. Helper: get database
# ==========================================
db_cache = None
last_cache_time = 0
CACHE_DURATION = 60
db_cache_by_scope = {}
last_cache_time_by_scope = {}

def normalize_scope_key(scope_key):
    s = (scope_key or DEFAULT_SCOPE_KEY).strip()
    return s if s else DEFAULT_SCOPE_KEY

def scoped_db_base(scope_key=None):
    safe_scope = quote(normalize_scope_key(scope_key), safe='')
    return f"{FIREBASE_DB_URL}/scopes/{safe_scope}"

def get_database_sync(force_refresh=False, scope_key=None):
    global db_cache, last_cache_time, db_cache_by_scope, last_cache_time_by_scope
    scope = normalize_scope_key(scope_key)
    now = time.time()
    if not force_refresh and db_cache_by_scope.get(scope) and (now - last_cache_time_by_scope.get(scope, 0) < CACHE_DURATION):
        return db_cache_by_scope[scope]
    try:
        import requests
        resp = requests.get(f"{scoped_db_base(scope)}/.json", timeout=10)
        if resp.status_code == 200:
            raw = resp.json()
            parsed = raw
            while parsed and isinstance(parsed.get('data'), str):
                try:
                    parsed = json.loads(parsed['data'])
                except:
                    break
            if parsed and isinstance(parsed.get('data'), dict):
                parsed = parsed['data']
            db_cache = parsed if parsed else {"database": {}}
            db_cache_by_scope[scope] = db_cache
            last_cache_time_by_scope[scope] = now
            last_cache_time = now
            return db_cache_by_scope[scope]
    except Exception as e:
        print(f"DB Fetch Error: {e}")
    return db_cache_by_scope.get(scope) if db_cache_by_scope.get(scope) else {"database": {}}

def get_all_scope_keys():
    try:
        import requests
        resp = requests.get(f"{FIREBASE_DB_URL}/scopes.json", timeout=10)
        if resp.status_code != 200:
            return [DEFAULT_SCOPE_KEY]
        data = resp.json() or {}
        if isinstance(data, dict) and data:
            return list(data.keys())
    except Exception as e:
        print(f"Scopes list error: {e}")
    return [DEFAULT_SCOPE_KEY]

def verify_firebase_id_token(id_token):
    try:
        if not id_token:
            return None
        decoded = firebase_auth.verify_id_token(id_token)
        return decoded
    except Exception as e:
        print(f"Token verify error: {e}")
        return None

def is_scope_admin(scope_key, email):
    if not email:
        return False
    db = get_database_sync(force_refresh=True, scope_key=scope_key)
    owner_email = str(db.get('ownerEmail') or 'peacemaker3050@gmail.com').strip().lower()
    admins = [str(a).strip().lower() for a in (db.get('admins') or [])]
    email_l = str(email).strip().lower()
    return email_l == owner_email or email_l in admins

# ==========================================
# 6. Helper: send FCM to all tokens
# ==========================================
def clean_invalid_tokens(user_tokens, token_results, all_tokens, scope_key=None):
    """Remove invalid/expired tokens from Firebase"""
    try:
        import requests
        invalid_tokens = set()
        for i, result in enumerate(token_results):
            if not result.success:
                err = str(result.exception)
                if 'registration-token-not-registered' in err or 'invalid-registration-token' in err or 'InvalidRegistration' in err:
                    if i < len(all_tokens):
                        invalid_tokens.add(all_tokens[i])

        if not invalid_tokens:
            return

        print(f"🧹 Cleaning {len(invalid_tokens)} invalid tokens...")
        for safe_email, user_data in user_tokens.items():
            if isinstance(user_data, dict):
                old_tokens = user_data.get('tokens', [])
                new_tokens = [t for t in old_tokens if t not in invalid_tokens]
                if len(new_tokens) != len(old_tokens):
                    user_data['tokens'] = new_tokens
                    requests.put(
                        f"{scoped_db_base(scope_key)}/userTokens/{safe_email}.json",
                        json=user_data, timeout=10
                    )
                    print(f"🧹 Cleaned tokens for {safe_email}")
    except Exception as e:
        print(f"Clean tokens error: {e}")

def send_fcm_all(title, body, scope_key=None):
    try:
        import requests
        print(f"📤 send_fcm_all called: {title} | {body}")
        resp = requests.get(f"{scoped_db_base(scope_key)}/userTokens.json", timeout=10)
        print(f"📤 userTokens status: {resp.status_code}")
        if resp.status_code != 200:
            return 0, 0
        user_tokens = resp.json()
        print(f"📤 userTokens raw: {list(user_tokens.keys()) if user_tokens else 'EMPTY'}")
        if not user_tokens:
            return 0, 0
        tokens = []
        for user_data in user_tokens.values():
            if isinstance(user_data, list):
                tokens.extend(user_data)
            elif isinstance(user_data, dict):
                tokens.extend(user_data.get('tokens', []))
        print(f"📤 Total tokens found: {len(tokens)}")
        if not tokens:
            print("📤 No tokens — aborting")
            return 0, 0
        messages = [
            messaging.Message(
                notification=messaging.Notification(
                    title=title,
                    body=body,
                    image='https://peacemaker3050-ux.github.io/2ndMec/icon-512.png'
                ),
                android=messaging.AndroidConfig(
                    priority='high',
                    notification=messaging.AndroidNotification(
                        icon='https://peacemaker3050-ux.github.io/2ndMec/icon-512.png',
                        color='#3b82f6'
                    )
                ),
                apns=messaging.APNSConfig(headers={'apns-priority': '10'}),
                webpush=messaging.WebpushConfig(
                    notification=messaging.WebpushNotification(
                        icon='https://peacemaker3050-ux.github.io/2ndMec/icon-512.png',
                        badge='https://peacemaker3050-ux.github.io/2ndMec/icon-512.png'
                    )
                ),
                token=token
            ) for token in tokens
        ]
        response = messaging.send_each(messages)
        success = sum(1 for r in response.responses if r.success)
        failure = len(response.responses) - success
        print(f"FCM All: {success} success, {failure} failure")
        for i, r in enumerate(response.responses):
            if not r.success:
                print(f"❌ Token[{i}] failed: {r.exception}")
        if failure > 0:
            clean_invalid_tokens(user_tokens, response.responses, tokens, scope_key)
        return success, failure
    except Exception as e:
        print(f"FCM Error: {e}")
        return 0, 0

# ==========================================
# 7. Helper: send FCM to new-files-enabled tokens only
# ==========================================
def send_fcm_new_files(title, body, scope_key=None):
    try:
        import requests
        resp = requests.get(f"{scoped_db_base(scope_key)}/userTokens.json", timeout=10)
        if resp.status_code != 200:
            return 0, 0
        user_tokens = resp.json()
        if not user_tokens:
            return 0, 0
        tokens = []
        for user_data in user_tokens.values():
            if isinstance(user_data, dict):
                if user_data.get('newFilesEnabled', False):
                    tokens.extend(user_data.get('tokens', []))
        if not tokens:
            print("FCM New Files: No opted-in tokens")
            return 0, 0
        messages = [
            messaging.Message(
                notification=messaging.Notification(
                    title=title,
                    body=body,
                    image='https://peacemaker3050-ux.github.io/2ndMec/icon-512.png'
                ),
                android=messaging.AndroidConfig(
                    priority='high',
                    notification=messaging.AndroidNotification(
                        icon='https://peacemaker3050-ux.github.io/2ndMec/icon-512.png',
                        color='#3b82f6'
                    )
                ),
                apns=messaging.APNSConfig(headers={'apns-priority': '10'}),
                webpush=messaging.WebpushConfig(
                    notification=messaging.WebpushNotification(
                        icon='https://peacemaker3050-ux.github.io/2ndMec/icon-512.png',
                        badge='https://peacemaker3050-ux.github.io/2ndMec/icon-512.png'
                    )
                ),
                token=token
            ) for token in tokens
        ]
        response = messaging.send_each(messages)
        success = sum(1 for r in response.responses if r.success)
        failure = len(response.responses) - success
        print(f"FCM New Files: {success} success, {failure} failure")
        for i, r in enumerate(response.responses):
            if not r.success:
                print(f"FCM Fail token[{i}]: {r.exception}")
        if failure > 0:
            clean_invalid_tokens(user_tokens, response.responses, tokens, scope_key)
        return success, failure
    except Exception as e:
        print(f"FCM New Files Error: {e}")
        return 0, 0

# ==========================================
# 8. API Routes
# ==========================================

@app_flask.route('/health', methods=['GET'])
def health():
    return jsonify({"status": "ok", "service": "UniBot API"})

@app_flask.route('/chat/config', methods=['GET'])
def chat_config():
    return jsonify({
        "ok": True,
        "cloudinaryCloudName": os.environ.get("CLOUDINARY_CLOUD_NAME", ""),
        "cloudinaryUploadPreset": os.environ.get("CLOUDINARY_UPLOAD_PRESET", "")
    })

@app_flask.route('/chat/register', methods=['POST'])
def chat_register():
    data = request.get_json() or {}
    scope_key = normalize_scope_key(data.get('scopeKey'))
    name = str(data.get('name', '')).strip()
    phone = str(data.get('phone', '')).strip()
    id_token = str(data.get('idToken', '')).strip()
    student_code = str(data.get('studentCode', '')).strip()
    if not name or not phone:
        return jsonify({"error": "name and phone required"}), 400
    email = ''
    uid = ''
    if id_token:
        decoded = verify_firebase_id_token(id_token)
        if decoded:
            email = str(decoded.get('email', '')).strip().lower()
            uid = str(decoded.get('uid', '')).strip()
    now = int(time.time() * 1000)
    conn = get_chat_conn()
    cur = conn.cursor()
    # add email/uid/student_code columns if not exist
    try:
        cur.execute("ALTER TABLE chat_members ADD COLUMN email TEXT DEFAULT ''")
    except: pass
    try:
        cur.execute("ALTER TABLE chat_members ADD COLUMN uid TEXT DEFAULT ''")
    except: pass
    try:
        cur.execute("ALTER TABLE chat_members ADD COLUMN student_code TEXT DEFAULT ''")
    except: pass
    cur.execute("""
        INSERT INTO chat_members(scope_key, phone, name, email, uid, student_code, created_at)
        VALUES(?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(scope_key, phone) DO UPDATE SET
            name=excluded.name,
            email=CASE WHEN excluded.email != '' THEN excluded.email ELSE email END,
            uid=CASE WHEN excluded.uid != '' THEN excluded.uid ELSE uid END,
            student_code=CASE WHEN excluded.student_code != '' THEN excluded.student_code ELSE student_code END
    """, (scope_key, phone, name, email, uid, student_code, now))
    conn.commit()
    conn.close()
    return jsonify({"ok": True})

@app_flask.route('/chat/groups', methods=['GET'])
def chat_groups():
    scope_key = normalize_scope_key(request.args.get('scopeKey'))
    db = get_database_sync(force_refresh=False, scope_key=scope_key)
    subjects = list((db.get('database') or {}).keys())
    groups = [{"id": "general", "name": "General", "type": "general"}]
    for sub in subjects:
        groups.append({"id": f"subject::{sub}", "name": sub, "type": "subject"})
    return jsonify({"ok": True, "groups": groups})

@app_flask.route('/chat/messages', methods=['GET'])
def chat_messages_get():
    scope_key = normalize_scope_key(request.args.get('scopeKey'))
    group_id = str(request.args.get('groupId', 'general')).strip() or 'general'
    limit = max(1, min(100, int(request.args.get('limit', 50))))
    before_id = request.args.get('beforeId')
    conn = get_chat_conn()
    cur = conn.cursor()
    if before_id:
        cur.execute("""
            SELECT * FROM chat_messages
            WHERE scope_key=? AND group_id=? AND id < ?
            ORDER BY id DESC LIMIT ?
        """, (scope_key, group_id, int(before_id), limit))
    else:
        cur.execute("""
            SELECT * FROM chat_messages
            WHERE scope_key=? AND group_id=?
            ORDER BY id DESC LIMIT ?
        """, (scope_key, group_id, limit))
    rows = [dict(r) for r in cur.fetchall()]
    msg_ids = [r["id"] for r in rows]
    reaction_map = {}
    read_map = {}
    if msg_ids:
        q_marks = ",".join(["?"] * len(msg_ids))
        cur.execute(
            f"SELECT message_id, reaction, COUNT(*) as c FROM chat_reactions WHERE scope_key=? AND group_id=? AND message_id IN ({q_marks}) GROUP BY message_id, reaction",
            [scope_key, group_id, *msg_ids]
        )
        for rr in cur.fetchall():
            mid = rr["message_id"]
            if mid not in reaction_map:
                reaction_map[mid] = {}
            reaction_map[mid][rr["reaction"]] = rr["c"]
        cur.execute(
            f"SELECT message_id, COUNT(*) as c FROM chat_reads WHERE scope_key=? AND group_id=? AND message_id IN ({q_marks}) GROUP BY message_id",
            [scope_key, group_id, *msg_ids]
        )
        for sr in cur.fetchall():
            read_map[sr["message_id"]] = sr["c"]
    for r in rows:
        r["reactions"] = reaction_map.get(r["id"], {})
        r["read_count"] = read_map.get(r["id"], 0)
    conn.close()
    rows.reverse()
    return jsonify({"ok": True, "messages": rows})

@app_flask.route('/chat/messages', methods=['POST'])
def chat_messages_post():
    data = request.get_json() or {}
    scope_key = normalize_scope_key(data.get('scopeKey'))
    group_id = str(data.get('groupId', 'general')).strip() or 'general'
    sender_name = str(data.get('senderName', '')).strip()
    sender_phone = str(data.get('senderPhone', '')).strip()
    message_type = str(data.get('messageType', 'text')).strip() or 'text'
    message_text = str(data.get('messageText', '')).strip()
    media_url = str(data.get('mediaUrl', '')).strip()
    id_token = str(data.get('idToken', '')).strip()
    if not sender_name or not sender_phone:
        return jsonify({"error": "sender required"}), 400
    if message_type == 'text' and not message_text:
        return jsonify({"error": "messageText required"}), 400
    now = int(time.time() * 1000)
    conn = get_chat_conn()
    cur = conn.cursor()
    actor_is_admin = False
    if id_token:
        decoded = verify_firebase_id_token(id_token)
        actor_email = str((decoded or {}).get('email', '')).strip().lower()
        actor_is_admin = is_scope_admin(scope_key, actor_email)
    cur.execute("SELECT is_locked FROM chat_group_settings WHERE scope_key=? AND group_id=? LIMIT 1", (scope_key, group_id))
    lock_row = cur.fetchone()
    is_locked = bool(lock_row["is_locked"]) if lock_row else False
    if is_locked and not actor_is_admin:
        conn.close()
        return jsonify({"error": "group is locked"}), 403
    cur.execute("""
        INSERT INTO chat_messages(scope_key, group_id, sender_name, sender_phone, message_type, message_text, media_url, created_at)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?)
    """, (scope_key, group_id, sender_name, sender_phone, message_type, message_text, media_url, now))
    msg_id = cur.lastrowid
    conn.commit()
    conn.close()
    send_fcm_all(
        "💬 New chat message",
        f"{sender_name}: {message_text[:80] if message_text else 'Media message'}",
        scope_key=scope_key
    )
    return jsonify({"ok": True, "id": msg_id, "createdAt": now})
@app_flask.route('/chat/messages/delete', methods=['POST'])
def chat_message_delete():
    data = request.get_json() or {}
    scope_key = normalize_scope_key(data.get('scopeKey'))
    group_id = str(data.get('groupId', 'general')).strip() or 'general'
    message_id = int(data.get('messageId', 0) or 0)
    phone = str(data.get('phone', '')).strip()
    id_token = str(data.get('idToken', '')).strip()
    if message_id <= 0:
        return jsonify({"error": "invalid messageId"}), 400
    conn = get_chat_conn()
    cur = conn.cursor()
    # get the message first
    cur.execute("SELECT sender_phone FROM chat_messages WHERE id=? AND scope_key=?", (message_id, scope_key))
    row = cur.fetchone()
    if not row:
        conn.close()
        return jsonify({"error": "message not found"}), 404
    actor_is_admin = False
    actor_email = ''
    if id_token:
        decoded = verify_firebase_id_token(id_token)
        actor_email = str((decoded or {}).get('email', '')).strip().lower()
        actor_is_admin = is_scope_admin(scope_key, actor_email)
    sender_phone = str(row['sender_phone']).strip()
    # permission: own message OR admin
    if not actor_is_admin and sender_phone != phone:
        conn.close()
        return jsonify({"error": "not allowed"}), 403
    cur.execute("DELETE FROM chat_messages WHERE id=? AND scope_key=?", (message_id, scope_key))
    cur.execute("DELETE FROM chat_reactions WHERE message_id=? AND scope_key=?", (message_id, scope_key))
    conn.commit()
    conn.close()
    return jsonify({"ok": True})
@app_flask.route('/chat/reactions', methods=['POST'])
def chat_reactions_post():
    data = request.get_json() or {}
    scope_key = normalize_scope_key(data.get('scopeKey'))
    group_id = str(data.get('groupId', 'general')).strip() or 'general'
    message_id = int(data.get('messageId', 0) or 0)
    phone = str(data.get('phone', '')).strip()
    reaction = str(data.get('reaction', '')).strip()[:8]
    if message_id <= 0 or not phone or not reaction:
        return jsonify({"error": "invalid reaction payload"}), 400
    now = int(time.time() * 1000)
    conn = get_chat_conn()
    cur = conn.cursor()
    cur.execute("""
        INSERT INTO chat_reactions(scope_key, group_id, message_id, phone, reaction, created_at)
        VALUES(?, ?, ?, ?, ?, ?)
        ON CONFLICT(scope_key, group_id, message_id, phone) DO UPDATE SET reaction=excluded.reaction, created_at=excluded.created_at
    """, (scope_key, group_id, message_id, phone, reaction, now))
    conn.commit()
    conn.close()
    return jsonify({"ok": True})

@app_flask.route('/chat/read', methods=['POST'])
def chat_read_post():
    data = request.get_json() or {}
    scope_key = normalize_scope_key(data.get('scopeKey'))
    group_id = str(data.get('groupId', 'general')).strip() or 'general'
    phone = str(data.get('phone', '')).strip()
    message_ids = data.get('messageIds') or []
    if not phone or not isinstance(message_ids, list):
        return jsonify({"error": "invalid read payload"}), 400
    now = int(time.time() * 1000)
    conn = get_chat_conn()
    cur = conn.cursor()
    for mid in message_ids[:200]:
        try:
            msg_id = int(mid)
            if msg_id <= 0:
                continue
            cur.execute("""
                INSERT OR IGNORE INTO chat_reads(scope_key, group_id, message_id, phone, created_at)
                VALUES(?, ?, ?, ?, ?)
            """, (scope_key, group_id, msg_id, phone, now))
        except:
            continue
    conn.commit()
    conn.close()
    return jsonify({"ok": True})

@app_flask.route('/chat/group-lock', methods=['POST'])
def chat_group_lock_post():
    data = request.get_json() or {}
    scope_key = normalize_scope_key(data.get('scopeKey'))
    group_id = str(data.get('groupId', 'general')).strip() or 'general'
    is_locked = 1 if bool(data.get('isLocked', False)) else 0
    id_token = str(data.get('idToken', '')).strip()
    decoded = verify_firebase_id_token(id_token)
    actor_email = str((decoded or {}).get('email', '')).strip().lower()
    if not actor_email or not is_scope_admin(scope_key, actor_email):
        return jsonify({"error": "unauthorized"}), 403
    now = int(time.time() * 1000)
    conn = get_chat_conn()
    cur = conn.cursor()
    cur.execute("""
        INSERT INTO chat_group_settings(scope_key, group_id, is_locked, updated_by, updated_at)
        VALUES(?, ?, ?, ?, ?)
        ON CONFLICT(scope_key, group_id) DO UPDATE SET is_locked=excluded.is_locked, updated_by=excluded.updated_by, updated_at=excluded.updated_at
    """, (scope_key, group_id, is_locked, actor_email, now))
    conn.commit()
    conn.close()
    return jsonify({"ok": True, "isLocked": bool(is_locked)})
@app_flask.route('/chat/members', methods=['GET'])
def chat_members_get():
    scope_key = normalize_scope_key(request.args.get('scopeKey'))
    id_token = str(request.args.get('idToken', '')).strip()
    if not id_token:
        return jsonify({"error": "auth required"}), 401
    decoded = verify_firebase_id_token(id_token)
    actor_email = str((decoded or {}).get('email', '')).strip().lower()
    if not is_scope_admin(scope_key, actor_email):
        return jsonify({"error": "admin only"}), 403
    conn = get_chat_conn()
    cur = conn.cursor()
    cur.execute("SELECT id, name, phone, created_at FROM chat_members WHERE scope_key=? ORDER BY created_at DESC", (scope_key,))
    rows = cur.fetchall()
    conn.close()
    members = [{"id": r["id"], "name": r["name"], "phone": r["phone"], "email": r["email"] if "email" in r.keys() else "", "uid": r["uid"] if "uid" in r.keys() else "", "student_code": r["student_code"] if "student_code" in r.keys() else "", "created_at": r["created_at"]} for r in rows]
    return jsonify({"members": members})
@app_flask.route('/chat/group-state', methods=['GET'])
def chat_group_state_get():
    scope_key = normalize_scope_key(request.args.get('scopeKey'))
    group_id = str(request.args.get('groupId', 'general')).strip() or 'general'
    conn = get_chat_conn()
    cur = conn.cursor()
    cur.execute("SELECT is_locked, updated_by, updated_at FROM chat_group_settings WHERE scope_key=? AND group_id=? LIMIT 1", (scope_key, group_id))
    row = cur.fetchone()
    cur.execute("SELECT COUNT(*) as c FROM chat_members WHERE scope_key=?", (scope_key,))
    members = int((cur.fetchone() or {"c": 0})["c"])
    conn.close()
    return jsonify({
        "ok": True,
        "isLocked": bool(row["is_locked"]) if row else False,
        "updatedBy": row["updated_by"] if row else None,
        "updatedAt": row["updated_at"] if row else None,
        "membersInScope": members
    })

# --- Send notification to all users ---
@app_flask.route('/send-notification', methods=['POST'])
def send_notification():
    data = request.get_json()
    if not data:
        return jsonify({"error": "No data"}), 400
    title = data.get('title', '')
    body  = data.get('body', '')
    scope_key = data.get('scopeKey') or DEFAULT_SCOPE_KEY
    if not title or not body:
        return jsonify({"error": "title and body required"}), 400
    success, failure = send_fcm_all(title, body, scope_key=scope_key)
    return jsonify({"success": success, "failure": failure})

# --- Helper: get or create folder by name inside a parent ---
def get_or_create_folder(service, name, parent_id):
    # Search for existing folder
    query = f"name='{name}' and '{parent_id}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false"
    results = service.files().list(q=query, fields="files(id, name)").execute()
    files = results.get('files', [])
    if files:
        print(f"📁 Found folder: {name} ({files[0]['id']})")
        return files[0]['id']
    # Create folder
    metadata = {
        'name': name,
        'mimeType': 'application/vnd.google-apps.folder',
        'parents': [parent_id]
    }
    folder = service.files().create(body=metadata, fields='id').execute()
    print(f"📁 Created folder: {name} ({folder['id']})")
    return folder['id']

# --- Upload file to Google Drive ---
@app_flask.route('/upload-file', methods=['POST'])
def upload_file():
    if 'file' not in request.files:
        return jsonify({"error": "No file"}), 400
    file        = request.files['file']
    subject     = request.form.get('subject', '')
    doctor      = request.form.get('doctor', '')
    folder_path = request.form.get('folder_path', '')  # e.g. "Lectures/Week1"
    notify      = request.form.get('notify', 'true') == 'true'
    scope_key   = normalize_scope_key(request.form.get('scopeKey', DEFAULT_SCOPE_KEY))

    try:
        service = get_drive_service()

        # Navigate/create folder structure:
        # Root -> Scopes -> scopeKey -> Subject -> Doctor -> [subfolders]
        current_folder_id = DRIVE_FOLDER_ID
        current_folder_id = get_or_create_folder(service, "Scopes", current_folder_id)
        current_folder_id = get_or_create_folder(service, scope_key, current_folder_id)

        if subject:
            current_folder_id = get_or_create_folder(service, subject, current_folder_id)
        if doctor:
            current_folder_id = get_or_create_folder(service, doctor, current_folder_id)

        # Handle extra subfolders e.g. "Lectures/Week1"
        if folder_path:
            for part in folder_path.split('/'):
                part = part.strip()
                if part:
                    current_folder_id = get_or_create_folder(service, part, current_folder_id)

        # Upload file into the final folder
        file_content = file.read()
        file_stream  = io.BytesIO(file_content)
        media = MediaIoBaseUpload(file_stream, mimetype=file.mimetype, resumable=True)
        file_metadata = {
            'name': file.filename,
            'parents': [current_folder_id]
        }
        uploaded = service.files().create(
            body=file_metadata,
            media_body=media,
            fields='id, name, webViewLink'
        ).execute()

        # Make file public
        service.permissions().create(
            fileId=uploaded['id'],
            body={'type': 'anyone', 'role': 'reader'}
        ).execute()

        drive_link = uploaded.get('webViewLink', '')
        file_id    = uploaded.get('id', '')

        print(f"✅ Uploaded: {file.filename} → {scope_key}/{subject}/{doctor}/{folder_path}")

        # Send FCM if notify enabled
        if notify:
            send_fcm_new_files(
                f"📂 New file — {subject}",
                file.filename,
                scope_key=scope_key
            )

        return jsonify({
            "success": True,
            "fileId": file_id,
            "fileName": file.filename,
            "link": drive_link,
            "scopeKey": scope_key
        })
    except Exception as e:
        print(f"Upload Error: {e}")
        return jsonify({"error": str(e)}), 500

# ==========================================
# 8.5 Voice Notes: Transcribe + Summarize + Shoubra AI Chat (Groq)
# ==========================================
GROQ_API_KEY = os.environ.get('GROQ_API_KEY', '')
GROQ_TRANSCRIBE_MODEL = "whisper-large-v3-turbo"
GROQ_CHAT_MODEL = "openai/gpt-oss-120b"

@app_flask.route('/transcribe', methods=['POST'])
def transcribe_audio():
    if not GROQ_API_KEY:
        return jsonify({"error": {"message": "GROQ_API_KEY غير مضبوط على السيرفر"}}), 500
    if 'file' not in request.files:
        return jsonify({"error": {"message": "لا يوجد ملف صوتي"}}), 400
    audio_file = request.files['file']
    try:
        import requests
        resp = requests.post(
            "https://api.groq.com/openai/v1/audio/transcriptions",
            headers={"Authorization": f"Bearer {GROQ_API_KEY}"},
            files={"file": (audio_file.filename or "audio.webm", audio_file.stream, audio_file.mimetype or "audio/webm")},
            data={
                "model": GROQ_TRANSCRIBE_MODEL,
                "response_format": "json",
                "prompt": "تسجيل محاضرة جامعية، الكلام ممكن يكون عربي أو إنجليزي أو عربي مع مصطلحات إنجليزية زي: السلام عليكم ورحمة الله وبركاته، المحاضرة النهاردة هنتكلم عن، هندسة ميكانيكية، Torque, Stress, Velocity."
            },
            timeout=60
        )
        data = resp.json()
        if resp.status_code != 200:
            print(f"❌ Transcribe Error: {data}")
            return jsonify({"error": {"message": data.get("error", {}).get("message", "فشل التفريغ")}}), 500
        return jsonify({"text": data.get("text", "")})
    except Exception as e:
        print(f"❌ Transcribe Exception: {e}")
        return jsonify({"error": {"message": str(e)}}), 500


@app_flask.route('/summarize', methods=['POST'])
def summarize_text():
    if not GROQ_API_KEY:
        return jsonify({"error": "GROQ_API_KEY غير مضبوط على السيرفر"}), 500
    body = request.get_json(force=True, silent=True) or {}
    text = (body.get('text') or '').strip()
    if not text:
        return jsonify({"error": "لا يوجد نص للتلخيص"}), 400
    try:
        import requests
        resp = requests.post(
            "https://api.groq.com/openai/v1/chat/completions",
            headers={"Authorization": f"Bearer {GROQ_API_KEY}", "Content-Type": "application/json"},
            json={
                "model": GROQ_CHAT_MODEL,
                "messages": [
                    {"role": "system", "content": "لخص النص التالي بالعربية في نقاط قصيرة وواضحة، من غير أي مقدمات."},
                    {"role": "user", "content": text}
                ],
                "temperature": 0.3
            },
            timeout=60
        )
        data = resp.json()
        if resp.status_code != 200:
            print(f"❌ Summarize Error: {data}")
            return jsonify({"error": "فشل التلخيص"}), 500
        summary = data["choices"][0]["message"]["content"]
        return jsonify({"summary": summary})
    except Exception as e:
        print(f"❌ Summarize Exception: {e}")
        return jsonify({"error": str(e)}), 500


@app_flask.route('/chat', methods=['POST'])
def sai_chat():
    if not GROQ_API_KEY:
        return jsonify({"reply": "عذرًا، مفتاح GROQ مش مضبوط على السيرفر."})
    body = request.get_json(force=True, silent=True) or {}
    system_msg = body.get('system', '')
    messages_in = body.get('messages', [])
    try:
        import requests
        groq_messages = []
        if system_msg:
            groq_messages.append({"role": "system", "content": system_msg})
        for m in messages_in:
            role = m.get('role', 'user')
            content = m.get('content', '')
            if isinstance(content, list):
                parts = []
                for part in content:
                    ptype = part.get('type')
                    if ptype == 'text':
                        parts.append(part.get('text', ''))
                    elif ptype == 'image':
                        parts.append('[مرفق صورة من المستخدم - غير مدعوم حاليًا]')
                    elif ptype == 'document':
                        parts.append('[مرفق ملف PDF من المستخدم - غير مدعوم حاليًا]')
                content = '\n'.join(parts)
            groq_messages.append({"role": role, "content": content})

        resp = requests.post(
            "https://api.groq.com/openai/v1/chat/completions",
            headers={"Authorization": f"Bearer {GROQ_API_KEY}", "Content-Type": "application/json"},
            json={"model": GROQ_CHAT_MODEL, "messages": groq_messages, "temperature": 0.5},
            timeout=60
        )
        data = resp.json()
        if resp.status_code != 200:
            print(f"❌ Chat Error: {data}")
            return jsonify({"reply": "حصل خطأ في الاتصال بالمساعد الذكي."})
        reply = data["choices"][0]["message"]["content"]
        return jsonify({"reply": reply})
    except Exception as e:
        print(f"❌ Chat Exception: {e}")
        return jsonify({"reply": "حصل خطأ غير متوقع."})

# ==========================================
# 9. Background Schedulers
# ==========================================

# --- Poll watcher ---
def poll_watcher():
    import requests
    print("🗳️ Poll Watcher started")
    last_poll_id_by_scope = {}
    time.sleep(30)
    while True:
        try:
            for scope_key in get_all_scope_keys():
                db = get_database_sync(force_refresh=True, scope_key=scope_key)
                poll = db.get('activePoll')
                if poll and not poll.get('ended', False):
                    poll_id = str(poll.get('question', '')) + str(poll.get('endsAt', 0))
                    ends_at_ms  = poll.get('endsAt', 0)
                    remaining_s = max(0, int((ends_at_ms - time.time() * 1000) / 1000))
                    if poll_id != last_poll_id_by_scope.get(scope_key) and remaining_s > 0:
                        print(f"🗳️ New poll [{scope_key}]: {poll.get('question','')}")
                        send_fcm_all(
                            "🗳️ New Poll — Vote Now!",
                            poll.get('question', 'A new poll is waiting for your vote'),
                            scope_key=scope_key
                        )
                        last_poll_id_by_scope[scope_key] = poll_id
        except Exception as e:
            print(f"Poll Watcher Error: {e}")
        time.sleep(30)

# --- Quick Links watcher ---
def quicklinks_watcher():
    import requests
    print("🔗 Quick Links Watcher started")
    last_count_by_scope = {}
    time.sleep(30)
    while True:
        try:
            for scope_key in get_all_scope_keys():
                db = get_database_sync(force_refresh=True, scope_key=scope_key)
                links = db.get('quickLinks', [])
                if not isinstance(links, list):
                    links = []
                count = len(links)
                prev = last_count_by_scope.get(scope_key, -1)
                if prev == -1:
                    last_count_by_scope[scope_key] = count
                elif count > prev:
                    new_link = links[-1]
                    print(f"🔗 New link [{scope_key}]: {new_link.get('title','')}")
                    send_fcm_all(
                        "🔗 New Link Added",
                        new_link.get('title', 'A new link is now available'),
                        scope_key=scope_key
                    )
                    last_count_by_scope[scope_key] = count
                else:
                    last_count_by_scope[scope_key] = count
        except Exception as e:
            print(f"Quick Links Watcher Error: {e}")
        time.sleep(30)

# --- New Files watcher ---
def new_files_watcher():
    import time
    print("📂 New Files Watcher started")
    last_seen_ts = int(time.time() * 1000)
    time.sleep(60)
    while True:
        try:
            db = get_database_sync(force_refresh=True)
            database = db.get('database', {})
            newest_ts      = 0
            newest_name    = ""
            newest_subject = ""

            def scan(items, subject_key):
                nonlocal newest_ts, newest_name, newest_subject
                if not isinstance(items, list):
                    return
                for item in items:
                    if item.get('type') == 'file' and item.get('ts', 0) > newest_ts:
                        newest_ts      = item['ts']
                        newest_name    = item.get('name', '')
                        newest_subject = subject_key
                    if item.get('type') == 'folder':
                        scan(item.get('children', []), subject_key)

            for subject_key, subject_val in database.items():
                if not isinstance(subject_val, dict):
                    continue
                for key, val in subject_val.items():
                    if key == 'doctors':
                        continue
                    if isinstance(val, dict) and 'root' in val:
                        scan(val['root'], subject_key)

            if newest_ts > last_seen_ts:
                print(f"🆕 New file: {newest_name} ({newest_subject})")
                send_fcm_new_files(
                    f"📂 New file — {newest_subject}",
                    newest_name
                )
                last_seen_ts = newest_ts
            else:
                print(f"📂 No new files (last_ts={last_seen_ts})")
        except Exception as e:
            print(f"New Files Watcher Error: {e}")
        time.sleep(60)

# --- Schedules watcher ---
def schedules_watcher():
    import requests as req
    print("⏰ Schedules Watcher started")
    time.sleep(30)
    while True:
        try:
            for scope_key in get_all_scope_keys():
                db = get_database_sync(force_refresh=True, scope_key=scope_key)
                schedules = db.get('schedules', [])
                if not isinstance(schedules, list):
                    schedules = []

                now = datetime.now()
                current_day = (now.weekday() + 1) % 7  # 0=Sunday like JavaScript
                current_time = now.strftime('%H:%M')
                changed = False

                for sched in schedules:
                    if not sched.get('active', False):
                        continue
                    sched_day  = sched.get('day', -1)
                    sched_time = sched.get('time', '')
                    last_triggered = sched.get('lastTriggered', 0)

                    if sched_day != current_day:
                        continue
                    try:
                        sched_h, sched_m = map(int, sched_time.split(':'))
                        sched_total = sched_h * 60 + sched_m
                        now_total   = now.hour * 60 + now.minute
                        if abs(now_total - sched_total) > 2:
                            continue
                    except:
                        continue

                    last_dt = datetime.fromtimestamp(last_triggered / 1000) if last_triggered else None
                    if last_dt and last_dt.date() == now.date() and last_dt.strftime('%H:%M') == current_time:
                        continue

                    subject = sched.get('subject', '')
                    doctor  = sched.get('doctor', '')
                    message = sched.get('message', '')

                    print(f"⏰ Firing schedule [{scope_key}]: {subject} - {doctor}: {message}")
                    send_fcm_all(
                        f"🔔 Reminder — {doctor} ({subject})",
                        message,
                        scope_key=scope_key
                    )

                    sched['lastTriggered'] = int(now.timestamp() * 1000)
                    changed = True

                if changed:
                    try:
                        full_db = get_database_sync(force_refresh=True, scope_key=scope_key)
                        full_db['schedules'] = schedules
                        import json as _json
                        req.patch(
                            f"{scoped_db_base(scope_key)}/.json",
                            json={'data': _json.dumps(full_db)},
                            timeout=10
                        )
                        print(f"⏰ Schedules updated in Firebase [{scope_key}]")
                    except Exception as e:
                        print(f"⏰ Schedule save error [{scope_key}]: {e}")

        except Exception as e:
            print(f"Schedules Watcher Error: {e}")
        time.sleep(60)  # Check every minute

# --- Doctor notifications watcher ---
def notifications_watcher():
    print("📢 Notifications Watcher started")
    last_notif_ts_by_scope = {}
    time.sleep(30)
    while True:
        try:
            for scope_key in get_all_scope_keys():
                db = get_database_sync(force_refresh=True, scope_key=scope_key)
                updates = db.get('recentUpdates', [])
                if updates and isinstance(updates, list):
                    newest = updates[0]
                    ts = newest.get('timestamp', 0)
                    last_ts = last_notif_ts_by_scope.get(scope_key, int(time.time() * 1000))
                    if ts > last_ts:
                        last_notif_ts_by_scope[scope_key] = ts
                        send_fcm_all(
                            f"📢 {newest.get('doctor','')} — {newest.get('subject','')}",
                            newest.get('message', 'اشعار جديد'),
                            scope_key=scope_key
                        )
                        print(f"📢 Notification sent [{scope_key}]: {newest.get('message','')}")
        except Exception as e:
            print(f"Notifications Watcher Error: {e}")
        time.sleep(30)

# --- Broadcast watcher ---
def broadcast_watcher():
    print("📣 Broadcast Watcher started")
    last_broadcast_ts_by_scope = {}
    time.sleep(30)
    while True:
        try:
            for scope_key in get_all_scope_keys():
                db = get_database_sync(force_refresh=True, scope_key=scope_key)
                broadcast = db.get('generalBroadcast', {})
                last_ts = last_broadcast_ts_by_scope.get(scope_key, 0)
                if broadcast.get('active') and broadcast.get('timestamp', 0) > last_ts:
                    last_broadcast_ts_by_scope[scope_key] = broadcast['timestamp']
                    send_fcm_all(
                        f"📣 {broadcast.get('title', 'اعلان جديد')}",
                        broadcast.get('body', ''),
                        scope_key=scope_key
                    )
                    print(f"📣 Broadcast sent [{scope_key}]: {broadcast.get('title','')}")
        except Exception as e:
            print(f"Broadcast Watcher Error: {e}")
        time.sleep(30)

# ==========================================
# 10. Start
# ==========================================
def start_watchers():
    print("🚀 Starting all watchers...")
    threading.Thread(target=poll_watcher,            daemon=True).start()
    threading.Thread(target=quicklinks_watcher,      daemon=True).start()
    threading.Thread(target=schedules_watcher,       daemon=True).start()
    threading.Thread(target=notifications_watcher,   daemon=True).start()
    threading.Thread(target=broadcast_watcher,       daemon=True).start()
    print("✅ All watchers started")

# Auto-start watchers when gunicorn loads the module
start_watchers()

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 8080))
    print(f"🚀 UniBot API running on port {port}")
    app_flask.run(host='0.0.0.0', port=port)