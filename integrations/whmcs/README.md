# Webcpl for WHMCS

A provisioning module: WHMCS creates, suspends, unsuspends, terminates and changes Webcpl accounts, and customers sign in to the panel from their client area.

## Install

1. Copy `modules/servers/webcpl` into your WHMCS `modules/servers/` folder.
2. In Webcpl, sign in as the admin (or a reseller), open **My account → API keys**, and create a key.
3. In WHMCS, add a server: type **Webcpl**, your server's hostname, port `7777` (tick SSL if the panel uses HTTPS), and the API key in **Access Hash**. Use **Test Connection**.
4. In each product, choose the **Webcpl** module and type the names of the Webcpl hosting plan, VPS plan, or both.

Usernames follow Webcpl's rule (3–16 lowercase letters or digits, starting with a letter); the module adjusts the one WHMCS proposes and saves it back to the service.
