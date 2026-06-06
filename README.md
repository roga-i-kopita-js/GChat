# Local Mattermost + Jitsi

Local test stand for macOS or Linux.

## Start

```bash
chmod +x setup.sh
./setup.sh
```

Open:

- Mattermost: http://localhost:8065
- Jitsi Meet: https://localhost:8443

Jitsi uses a self-signed local certificate. Accept the browser warning for local testing.

## Stop

```bash
docker compose down
```

## Remove all local data

```bash
docker compose down -v
rm -f .env
```

## Logs

```bash
docker compose ps
docker compose logs -f
```

## Test from another device in the same Wi-Fi network

1. Find the laptop IP address:

```bash
ipconfig getifaddr en0
```

2. Edit `.env`:

```env
JITSI_PUBLIC_URL=https://192.168.1.42:8443
JVB_ADVERTISE_IPS=192.168.1.42
```

3. Restart:

```bash
docker compose down
docker compose up -d
```

A self-signed certificate may prevent mobile browsers from using camera and microphone. For the first test, use two desktop browsers. Later configure a trusted local certificate or a public HTTPS domain.
