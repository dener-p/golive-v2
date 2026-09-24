/**
 * Tiny client-side i18n: pt-BR by default (most users are in Brazil) with an
 * EN toggle in the nav. Choice persists in localStorage; <html lang> stays in
 * sync. Server/helper/stats diagnostic strings are technical output and pass
 * through untranslated.
 */

export type Locale = 'pt-BR' | 'en';

const STORAGE_KEY = 'golive.locale';

type Dict = Record<string, string>;

const pt: Dict = {
  // nav / login
  'nav.home': 'início',
  'nav.host': 'host',
  'nav.localeTitle': 'Mudar para inglês',
  'login.title': 'Entre para transmitir',
  'login.sub':
    'Só hosts entram — é o que identifica o dono da sala. Espectadores só precisam abrir o link da sala.',
  'login.dev': 'Login de dev (sem Discord configurado)',
  'login.discord': 'Entrar com Discord',

  // home
  'home.subtitle':
    'Transmissão ao vivo em AV1 para audiências pequenas — tudo ponto a ponto, sem relay compartilhado.',
  'home.identity': 'Identidade',
  'home.signedInAs': 'Conectado como',
  'home.signOut': 'Sair',
  'home.signedOutHint':
    'Entre para criar uma sala. Assistir não precisa de conta — basta o link.',
  'home.devLogin': 'Login de dev',
  'home.discordLogin': 'Entrar com Discord',
  'home.hostTitle': 'Criar uma sala',
  'home.hostSub':
    'A sala pertence a você; só você entra como host. Espectadores só precisam do link.',
  'home.createRoom': 'Criar sala',
  'home.watchTitle': 'Assistir uma sala',
  'home.roomPlaceholder': 'id da sala (ex.: ab3x9k)',
  'home.watch': 'Assistir',
  'home.creating': 'Criando sala…',
  'home.roomCreated': 'Sala criada',
  'home.shareLink': 'Compartilhe este link com os espectadores:',
  'home.openHostPage': 'Abrir página do host',
  'home.copyLink': 'Copiar link',
  'home.createFailed': 'Falha ao criar sala: {err}',

  // host
  'host.title': 'Modo host',
  'host.unauthed': 'O modo host é liberado quando o helper nativo conecta no servidor.',
  'host.subtitle':
    'Os controles passam pelo servidor; o helper nativo só é alcançado por ele.',
  'host.roomCard': 'Sala',
  'host.watchLink': 'link de transmissão',
  'host.copy': 'copiar',
  'host.leave': 'sair',
  'host.noRoom': 'Nenhuma sala selecionada.',
  'host.createRoom': 'Criar sala',
  'host.helperCard': 'Helper nativo',
  'host.helperChecking': 'verificando…',
  'host.helperDesc':
    'O helper nativo captura sua tela, codifica em AV1 e transmite aos espectadores pelo servidor. Ele conecta de dentro para fora — nada roda em localhost.',
  'host.quality': 'Qualidade',
  'host.startLive': 'Iniciar ao vivo',
  'host.stopLive': 'Parar ao vivo',
  'host.starting': 'Iniciando…',
  'host.stopping': 'Parando…',
  'host.natTest': 'Autoteste NAT',
  'host.natMap': 'Sondagem NAT-mapa',
  'host.pairCard': 'Vincular o helper',
  'host.pairSkip': '(pule se ele já está rodando)',
  'host.pairSub':
    'O helper autentica com um token de dispositivo, não com sua sessão do navegador. Gere um código curto, rode o comando na sua máquina e o helper guarda o próprio token.',
  'host.pairGet': 'Gerar código de vinculação',
  'host.pairExpiry': 'Expira em {n} min. Rode o comando e então atualize esta página.',
  'host.pairCmdPref': 'Rode na máquina que vai transmitir:',
  'host.turnCard': 'Configuração de TURN (opcional)',
  'host.turnDesc':
    'Se o STUN não conseguir uma conexão direta, os espectadores vão precisar de um servidor TURN. Configure suas próprias credenciais abaixo (ex.: Cloudflare TURN).',
  'host.turnUsername': 'usuário',
  'host.turnCredential': 'senha',
  'host.turnSave': 'Salvar configuração de TURN',
  'host.turnClear': 'Limpar',
  'host.creating': 'Criando…',
  'host.failed': 'Falha: {err}',
  'host.turnUrlRequired': 'A URL de TURN é obrigatória.',
  'host.turnSaved': 'Configuração de TURN salva.',
  'host.turnCleared': 'Configuração de TURN removida.',
  'host.minting': 'Gerando código…',
  'host.codeReady': 'Código pronto — rode o comando e então atualize esta página.',
  'host.codeExpired': 'Código expirado — gere outro.',
  'host.noDevices': 'Nenhum dispositivo vinculado ainda.',
  'host.devicesHeader': 'Dispositivos vinculados (um por instalação do helper):',
  'host.revoke': 'Revogar',
  'host.revokeFailed': 'Falha ao revogar: {err}',
  'host.helperConnectedState': 'helper conectado · {state}',
  'host.helperOffline': 'helper offline',
  'host.lastSeen': 'visto por último às {time}',
  'host.helperUpdate': 'helper v{running} — <a href="/api/helper/download">atualização disponível: v{latest}</a>',
  'host.helperUpToDate': 'helper v{running} — atualizado',
  'host.helperConnected': 'helper conectado',
  'host.noHelperDownload':
    'Nenhum helper rodando ainda — <a class="btn small" href="/api/helper/download">Baixar helper v{ver}</a> <span class="muted">sha256 {sha}… · baixe, execute <code>golive-helper.exe</code> e atualize esta página</span>',
  'host.noHelperBuild':
    'Nenhum helper rodando. Compile em helper/ (cargo build --release) ou peça ao operador para publicar um download.',
  'host.cmdAccepted': '"{command}" aceito pelo helper · agora {state}{detail} às {time}',
  'host.cmdRejected': '"{command}" REJEITADO pelo helper{detail}',
  'host.cmdNotDelivered': 'Comando "{command}" NÃO entregue — helper offline.',
  'host.cmdRelayed': 'Comando "{command}" enviado — aguardando resposta do helper…',
  'host.createdBy': 'Criada por {name}',

  // watch
  'watch.missingRoom': 'Falta o id da sala.',
  'watch.roomNotFound': 'Sala não encontrada',
  'watch.notFoundSub': '“{id}” não existe. Peça o link correto ao host.',
  'watch.title': 'Assistir {id}',
  'watch.copyLink': 'copiar link da sala',
  'watch.waiting': 'Aguardando o host começar a transmitir…',
  'watch.av1Ok': ' · decodificação AV1 OK',
  'watch.av1Slow': ' · decodificação AV1 NÃO/lenta',
  'watch.receiving': 'Recebendo transmissão ao vivo.',
  'watch.connectedWaiting': 'Conectado ao host — aguardando vídeo…',
  'watch.peerState': 'Conexão {state}.',
  'watch.peerStateAfter': 'Conexão {state} depois de {s}s.',
  'watch.attempt': 'Tentativa {n}: {reason}',
  'watch.setupFailed': 'Não foi possível iniciar a mídia: {err}',
  'watch.joinFailed': 'Falha ao entrar: {err}',
  'watch.sigLost': '(conexão de sinalização perdida)',
  'watch.sigLostBeforeHost': 'Sinalização perdida antes de ver o host.',
  'watch.joined': '(entrou como espectador · {n})',
  'watch.viewer': 'espectador',
  'watch.viewers': 'espectadores',
  'watch.hostPresentConnecting': 'Anfitrião presente — conectando…',
  'watch.hostPresent': 'Anfitrião presente.',
  'watch.hostConnected': '(host conectado)',
  'watch.hostLeft': '(host saiu)',
  'watch.hostOffline':
    'Anfitrião ficou offline. Atualize para voltar quando ele retornar.',
  'watch.serverError': '{code}: {message}',
  'watch.noHost': '(nenhum host detectado)',
  'watch.noHostBroadcasting':
    'Nenhum host está transmitindo esta sala ainda — inicie o helper nativo ou o host de teste.',
  'watch.gather': 'coleta {ms}ms',
  'watch.check': 'checagem {ms}ms',
  'watch.firstFrame': 'primeiro frame {ms}ms',
  'watch.unmute': 'Ativar som',
  'watch.mute': 'Silenciar',
  'watch.fullscreen': 'Tela cheia',
};

const en: Dict = {
  'nav.home': 'home',
  'nav.host': 'host',
  'nav.localeTitle': 'Switch to Portuguese',
  'login.title': 'Sign in to host',
  'login.sub':
    'Only hosts sign in — it identifies the room owner. Viewers just open the room link.',
  'login.dev': 'Dev login (no Discord configured)',
  'login.discord': 'Log in with Discord',

  'home.subtitle':
    'AV1 live streaming for small audiences — fully peer-to-peer, no shared relay.',
  'home.identity': 'Identity',
  'home.signedInAs': 'Signed in as',
  'home.signOut': 'Sign out',
  'home.signedOutHint':
    'Sign in to host a room. Watching a room needs no account — just the link.',
  'home.devLogin': 'Dev login',
  'home.discordLogin': 'Log in with Discord',
  'home.hostTitle': 'Host a room',
  'home.hostSub':
    'A room is owned by you; only you can connect as its host. Viewers just need the link.',
  'home.createRoom': 'Create room',
  'home.watchTitle': 'Watch a room',
  'home.roomPlaceholder': 'room id (e.g. ab3x9k)',
  'home.watch': 'Watch',
  'home.creating': 'Creating room…',
  'home.roomCreated': 'Room created',
  'home.shareLink': 'Share this link with viewers:',
  'home.openHostPage': 'Open host page',
  'home.copyLink': 'Copy link',
  'home.createFailed': 'Failed to create room: {err}',

  'host.title': 'Host mode',
  'host.unauthed': 'Host mode unlocks once the native helper connects to the backend.',
  'host.subtitle':
    'Controls are driven by the backend; the native helper is reached only through it.',
  'host.roomCard': 'Room',
  'host.watchLink': 'watch link',
  'host.copy': 'copy',
  'host.leave': 'leave',
  'host.noRoom': 'No room selected.',
  'host.createRoom': 'Create room',
  'host.helperCard': 'Native helper',
  'host.helperChecking': 'checking…',
  'host.helperDesc':
    'The native helper captures your screen, encodes AV1, and streams to viewers through the backend. It connects outward to the server — nothing runs on localhost.',
  'host.quality': 'Quality',
  'host.startLive': 'Start live',
  'host.stopLive': 'Stop live',
  'host.starting': 'Starting…',
  'host.stopping': 'Stopping…',
  'host.natTest': 'NAT self-test',
  'host.natMap': 'NAT-map probe',
  'host.pairCard': 'Pair the helper',
  'host.pairSkip': '(skip if it is already running)',
  'host.pairSub':
    'The helper authenticates with a device token, not your browser session. Mint a short code, run the command on your machine, and the helper stores its own token.',
  'host.pairGet': 'Get pairing code',
  'host.pairExpiry': 'Expires in {n} min. Run it, then refresh this page.',
  'host.pairCmdPref': 'Run this on the machine that will stream:',
  'host.turnCard': 'TURN configuration (optional)',
  'host.turnDesc':
    'If STUN cannot establish a direct connection, viewers will need a TURN server. Configure your own TURN credentials below (e.g. Cloudflare TURN).',
  'host.turnUsername': 'username',
  'host.turnCredential': 'credential',
  'host.turnSave': 'Save TURN config',
  'host.turnClear': 'Clear',
  'host.creating': 'Creating…',
  'host.failed': 'Failed: {err}',
  'host.turnUrlRequired': 'TURN URL is required.',
  'host.turnSaved': 'TURN config saved.',
  'host.turnCleared': 'TURN config cleared.',
  'host.minting': 'Minting code…',
  'host.codeReady': 'Code ready — run the command, then refresh this page.',
  'host.codeExpired': 'Code expired — mint a new one.',
  'host.noDevices': 'No paired devices yet.',
  'host.devicesHeader': 'Paired devices (one per helper install):',
  'host.revoke': 'Revoke',
  'host.revokeFailed': 'Revoke failed: {err}',
  'host.helperConnectedState': 'helper connected · {state}',
  'host.helperOffline': 'helper offline',
  'host.lastSeen': 'last seen {time}',
  'host.helperUpdate':
    'helper v{running} — <a href="/api/helper/download">update available: v{latest}</a>',
  'host.helperUpToDate': 'helper v{running} — up to date',
  'host.helperConnected': 'helper connected',
  'host.noHelperDownload':
    'No helper running yet — <a class="btn small" href="/api/helper/download">Download helper v{ver}</a> <span class="muted">sha256 {sha}… · download, run <code>golive-helper.exe</code>, then refresh this page</span>',
  'host.noHelperBuild':
    'No helper is running. Build one from helper/ (cargo build --release) or ask the operator to publish a download.',
  'host.cmdAccepted': '"{command}" accepted by helper · now {state}{detail} @ {time}',
  'host.cmdRejected': '"{command}" REJECTED by helper{detail}',
  'host.cmdNotDelivered': 'Command "{command}" NOT delivered — helper offline.',
  'host.cmdRelayed': 'Command "{command}" relayed — awaiting helper ack…',
  'host.createdBy': 'Created by {name}',

  'watch.missingRoom': 'Missing room id.',
  'watch.roomNotFound': 'Room not found',
  'watch.notFoundSub': '“{id}” doesn’t exist. Ask the host for the correct link.',
  'watch.title': 'Watch {id}',
  'watch.copyLink': 'copy room link',
  'watch.waiting': 'Waiting for the host to start broadcasting…',
  'watch.av1Ok': ' · AV1 decode OK',
  'watch.av1Slow': ' · AV1 decode NO/slow',
  'watch.receiving': 'Receiving live media.',
  'watch.connectedWaiting': 'Connected to host — waiting for video…',
  'watch.peerState': 'Peer {state}.',
  'watch.peerStateAfter': 'Peer {state} after {s}s.',
  'watch.attempt': 'Attempt {n}: {reason}',
  'watch.setupFailed': 'Could not set up media: {err}',
  'watch.joinFailed': 'Join attempt failed: {err}',
  'watch.sigLost': '(signaling connection lost)',
  'watch.sigLostBeforeHost': 'Signaling lost before the host was seen.',
  'watch.joined': '(joined as viewer · {n})',
  'watch.viewer': 'viewer',
  'watch.viewers': 'viewers',
  'watch.hostPresentConnecting': 'Host present — connecting…',
  'watch.hostPresent': 'Host present.',
  'watch.hostConnected': '(host connected)',
  'watch.hostLeft': '(host left)',
  'watch.hostOffline': 'Host went offline. Refresh to re-join when they return.',
  'watch.serverError': '{code}: {message}',
  'watch.noHost': '(no host detected)',
  'watch.noHostBroadcasting':
    'No host is broadcasting this room yet — start the native helper or the test host.',
  'watch.gather': 'gather {ms}ms',
  'watch.check': 'check {ms}ms',
  'watch.firstFrame': 'first frame {ms}ms',
  'watch.unmute': 'Unmute',
  'watch.mute': 'Mute',
  'watch.fullscreen': 'Fullscreen',
};

export function locale(): Locale {
  return localStorage.getItem(STORAGE_KEY) === 'en' ? 'en' : 'pt-BR';
}

/** The locale shown by the nav toggle — i.e. the one a click switches to. */
export function otherLocale(): Locale {
  return locale() === 'pt-BR' ? 'en' : 'pt-BR';
}

export function setLocale(next: Locale): void {
  localStorage.setItem(STORAGE_KEY, next);
  document.documentElement.lang = next;
}

export function t(key: string, vars?: Record<string, string | number>): string {
  let s = (locale() === 'pt-BR' ? pt : en)[key] ?? en[key] ?? key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      s = s.replaceAll(`{${k}}`, String(v));
    }
  }
  return s;
}