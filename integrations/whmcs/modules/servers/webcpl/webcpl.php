<?php
/**
 * Webcpl provisioning module for WHMCS.
 *
 * Creates, suspends, unsuspends, terminates and changes Webcpl accounts through the panel's
 * API, and signs customers in with a one-time link. Set the server's hostname and port
 * (7777 by default) and put an admin or reseller API key in the "Access Hash" field.
 */

if (!defined('WHMCS')) {
    die('This file cannot be accessed directly');
}

function webcpl_MetaData()
{
    return [
        'DisplayName' => 'Webcpl',
        'APIVersion' => '1.1',
        'RequiresServer' => true,
        'DefaultNonSSLPort' => '7777',
        'DefaultSSLPort' => '7777',
        'ServiceSingleSignOnLabel' => 'Log in to Webcpl',
    ];
}

function webcpl_ConfigOptions()
{
    return [
        'Hosting plan' => ['Type' => 'text', 'Size' => '30', 'Description' => 'Name of a Webcpl hosting plan, or empty'],
        'VPS plan' => ['Type' => 'text', 'Size' => '30', 'Description' => 'Name of a Webcpl VPS plan, or empty'],
    ];
}

/** Calls the Webcpl API and returns the decoded answer, or throws with its error message. */
function webcpl_api(array $params, $method, $path, array $body = null)
{
    $scheme = !empty($params['serversecure']) ? 'https' : 'http';
    $host = $params['serverhostname'] ?: $params['serverip'];
    $port = $params['serverport'] ?: '7777';
    $ch = curl_init("{$scheme}://{$host}:{$port}{$path}");
    $headers = ['Authorization: Bearer ' . $params['serveraccesshash'], 'Accept: application/json'];
    if ($body !== null) {
        $headers[] = 'Content-Type: application/json';
        curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($body));
    }
    curl_setopt_array($ch, [
        CURLOPT_CUSTOMREQUEST => $method,
        CURLOPT_HTTPHEADER => $headers,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT => 120,
    ]);
    $raw = curl_exec($ch);
    $status = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $error = curl_error($ch);
    curl_close($ch);
    logModuleCall('webcpl', "{$method} {$path}", $body === null ? '' : json_encode(array_diff_key($body, ['password' => 1])), $raw);
    if ($raw === false) {
        throw new Exception("Could not reach Webcpl: {$error}");
    }
    $data = json_decode($raw, true);
    if ($status >= 400) {
        throw new Exception(isset($data['error']) ? $data['error'] : "Webcpl answered with HTTP {$status}");
    }
    return $data ?: [];
}

function webcpl_planId(array $params, $name, $kind)
{
    $name = trim((string) $name);
    if ($name === '') {
        return null;
    }
    foreach (webcpl_api($params, 'GET', '/api/plans?kind=' . $kind)['plans'] as $plan) {
        if (strcasecmp($plan['name'], $name) === 0) {
            return $plan['id'];
        }
    }
    throw new Exception("Webcpl has no {$kind} plan named \"{$name}\"");
}

function webcpl_accountId(array $params)
{
    foreach (webcpl_api($params, 'GET', '/api/accounts')['accounts'] as $account) {
        if ($account['username'] === $params['username']) {
            return $account['id'];
        }
    }
    throw new Exception("Webcpl has no account named {$params['username']}");
}

/** Webcpl usernames are 3-16 lowercase letters or digits, starting with a letter. */
function webcpl_username($wanted)
{
    $name = preg_replace('/[^a-z0-9]/', '', strtolower($wanted));
    if ($name === '' || !ctype_alpha($name[0])) {
        $name = 'u' . $name;
    }
    return substr(str_pad($name, 3, '0'), 0, 16);
}

function webcpl_CreateAccount(array $params)
{
    try {
        $username = webcpl_username($params['username'] ?: $params['domain']);
        if ($username !== $params['username']) {
            $params['model']->serviceProperties->save(['username' => $username]);
            $params['username'] = $username;
        }
        webcpl_api($params, 'POST', '/api/accounts', [
            'username' => $username,
            'password' => $params['password'],
            'email' => $params['clientsdetails']['email'],
            'hostingPlanId' => webcpl_planId($params, $params['configoption1'], 'hosting'),
            'vpsPlanId' => webcpl_planId($params, $params['configoption2'], 'vps'),
            'mustChangePassword' => false,
            'note' => 'WHMCS service #' . $params['serviceid'],
        ]);
        return 'success';
    } catch (Exception $e) {
        return $e->getMessage();
    }
}

function webcpl_SuspendAccount(array $params)
{
    try {
        $id = webcpl_accountId($params);
        webcpl_api($params, 'POST', "/api/accounts/{$id}/suspend", ['reason' => $params['suspendreason'] ?: 'Suspended by billing']);
        return 'success';
    } catch (Exception $e) {
        return $e->getMessage();
    }
}

function webcpl_UnsuspendAccount(array $params)
{
    try {
        $id = webcpl_accountId($params);
        webcpl_api($params, 'POST', "/api/accounts/{$id}/unsuspend", []);
        return 'success';
    } catch (Exception $e) {
        return $e->getMessage();
    }
}

function webcpl_TerminateAccount(array $params)
{
    try {
        $id = webcpl_accountId($params);
        webcpl_api($params, 'DELETE', "/api/accounts/{$id}", ['confirm' => $params['username']]);
        return 'success';
    } catch (Exception $e) {
        return $e->getMessage();
    }
}

function webcpl_ChangePassword(array $params)
{
    try {
        $id = webcpl_accountId($params);
        webcpl_api($params, 'POST', "/api/accounts/{$id}/reset-password", ['password' => $params['password']]);
        return 'success';
    } catch (Exception $e) {
        return $e->getMessage();
    }
}

function webcpl_ChangePackage(array $params)
{
    try {
        $id = webcpl_accountId($params);
        webcpl_api($params, 'PATCH', "/api/accounts/{$id}", [
            'hostingPlanId' => webcpl_planId($params, $params['configoption1'], 'hosting'),
            'vpsPlanId' => webcpl_planId($params, $params['configoption2'], 'vps'),
        ]);
        return 'success';
    } catch (Exception $e) {
        return $e->getMessage();
    }
}

function webcpl_TestConnection(array $params)
{
    try {
        $me = webcpl_api($params, 'GET', '/api/auth/me');
        if (empty($me['user']) || !in_array($me['user']['role'], ['admin', 'reseller'], true)) {
            return ['success' => false, 'error' => 'The API key must belong to the Webcpl admin or a reseller.'];
        }
        return ['success' => true, 'error' => ''];
    } catch (Exception $e) {
        return ['success' => false, 'error' => $e->getMessage()];
    }
}

function webcpl_ServiceSingleSignOn(array $params)
{
    try {
        $id = webcpl_accountId($params);
        $link = webcpl_api($params, 'POST', "/api/accounts/{$id}/login-link", []);
        return ['success' => true, 'redirectTo' => $link['url']];
    } catch (Exception $e) {
        return ['success' => false, 'errorMsg' => $e->getMessage()];
    }
}

function webcpl_ClientArea(array $params)
{
    return [
        'templatefile' => 'clientarea',
        'vars' => ['panelUrl' => (!empty($params['serversecure']) ? 'https' : 'http') . '://' . ($params['serverhostname'] ?: $params['serverip']) . ':' . ($params['serverport'] ?: '7777')],
    ];
}
