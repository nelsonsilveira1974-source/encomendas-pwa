/* =============================================
   Facebook Comment Bot — Server
   Express Server + Facebook Webhook Integration
   ============================================= */

require('dotenv').config();
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const dbPath = path.join(__dirname, 'orders_db.json');

function readOrdersFromDB() {
  try {
    if (!fs.existsSync(dbPath)) {
      fs.writeFileSync(dbPath, '[]');
      return [];
    }
    const data = fs.readFileSync(dbPath, 'utf8');
    return JSON.parse(data || '[]');
  } catch (e) {
    console.error('❌ Erro ao ler base de dados JSON:', e.message);
    return [];
  }
}

function writeOrdersToDB(orders) {
  try {
    fs.writeFileSync(dbPath, JSON.stringify(orders, null, 2));
  } catch (e) {
    console.error('❌ Erro ao escrever na base de dados JSON:', e.message);
  }
}

async function saveOrderToDB(newOrder) {
  try {
    const orders = readOrdersFromDB();
    orders.push(newOrder);
    writeOrdersToDB(orders);
    console.log(`✅ [DB] Encomenda de ${newOrder.name} guardada em orders_db.json!`);
  } catch (e) {
    console.error('❌ Erro ao guardar encomenda na base de dados:', e.message);
  }
}

// Buffer de Logs em memória para monitorização fácil via browser
const logs = [];
const originalConsole = {
  log: console.log,
  warn: console.warn,
  error: console.error
};

function addLog(type, ...args) {
  const msg = args.map(arg => typeof arg === 'object' ? JSON.stringify(arg, null, 2) : arg).join(' ');
  const time = new Date().toISOString();
  logs.push(`[${time}] [${type}] ${msg}`);
  if (logs.length > 200) logs.shift();
  originalConsole[type.toLowerCase() === 'log' ? 'log' : type.toLowerCase() === 'warn' ? 'warn' : 'error'](...args);
}

console.log = (...args) => addLog('LOG', ...args);
console.warn = (...args) => addLog('WARN', ...args);
console.error = (...args) => addLog('ERROR', ...args);

const app = express();
app.use(express.json());

// CORS Middleware personalizado
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

const PORT = process.env.PORT || 5000;
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const REPLY_TEMPLATE = process.env.REPLY_TEMPLATE || 'Olá {nome}! Completa a tua encomenda aqui... :) {link}';
const MESSENGER_CHATBOT_ACTIVE = process.env.MESSENGER_CHATBOT_ACTIVE === 'true';

// Test Page Access Token on boot (optional warning)
if (!PAGE_ACCESS_TOKEN || PAGE_ACCESS_TOKEN === 'O_TEU_PAGE_ACCESS_TOKEN_AQUI') {
  console.warn('⚠️ AVISO: PAGE_ACCESS_TOKEN não está configurado corretamente no ficheiro .env');
}
if (!VERIFY_TOKEN || VERIFY_TOKEN === 'o_teu_token_de_verificacao_secreto') {
  console.warn('⚠️ AVISO: VERIFY_TOKEN está a usar o valor padrão no ficheiro .env');
}

// Rota de visualização de logs em tempo real
app.get('/logs', (req, res) => {
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.send(logs.join('\n'));
});

/* ─────────────────────────────────────────────
   FUNÇÃO AUXILIAR: Verificar se é Direto Ativo (LIVE)
   ───────────────────────────────────────────── */
async function isPostCurrentlyLive(postId, accessToken) {
  try {
    console.log(`[LIVE CHECK] A verificar ID do post: ${postId}`);
    
    // ESTRATÉGIA A: Tentar obter o object_id do post (caso seja um Post normal associado a um vídeo)
    let objectId = null;
    try {
      const postResponse = await axios.get(
        `https://graph.facebook.com/v19.0/${postId}`,
        {
          params: {
            fields: 'object_id,status_type',
            access_token: accessToken
          }
        }
      );
      const postData = postResponse.data;
      console.log(`[LIVE CHECK] Dados do post (Estrutura A):`, JSON.stringify(postData));
      objectId = postData.object_id;
    } catch (e) {
      console.log(`[LIVE CHECK] Falha ao ler post (Estrutura A - pode ser ID de vídeo direto): ${e.message}`);
    }

    // ESTRATÉGIA B: Consultar o estado do vídeo (usando objectId se disponível, senão o próprio postId)
    const targetId = objectId || postId;
    console.log(`[LIVE CHECK] A verificar estado da transmissão no ID do objeto: ${targetId}`);
    
    try {
      const videoResponse = await axios.get(
        `https://graph.facebook.com/v19.0/${targetId}`,
        {
          params: {
            fields: 'live_status,broadcast_status,status',
            access_token: accessToken
          }
        }
      );
      const videoData = videoResponse.data;
      console.log(`[LIVE CHECK] Dados do vídeo (Estrutura B):`, JSON.stringify(videoData));

      const liveStatus = (videoData.live_status || '').toUpperCase();
      const broadcastStatus = (videoData.broadcast_status || '').toUpperCase();
      const status = (videoData.status || '').toUpperCase();

      const isLive = liveStatus === 'LIVE' || broadcastStatus === 'LIVE' || status === 'LIVE';
      console.log(`[LIVE CHECK] Resultado (Estrutura B): live_status=${liveStatus}, broadcast_status=${broadcastStatus}, status=${status} -> isLive=${isLive}`);
      if (isLive) return true;
    } catch (e) {
      console.log(`[LIVE CHECK] Falha ao ler vídeo (Estrutura B): ${e.message}`);
    }

    // ESTRATÉGIA C: Listar diretos ativos da página (/live_videos?broadcast_status=LIVE)
    try {
      const pageId = postId.split('_')[0];
      if (pageId && pageId.match(/^\d+$/)) {
        console.log(`[LIVE CHECK] A listar diretos ativos da página ${pageId} (Estrutura C)...`);
        const liveVideosResponse = await axios.get(
          `https://graph.facebook.com/v19.0/${pageId}/live_videos`,
          {
            params: {
              broadcast_status: 'LIVE',
              fields: 'id,video',
              access_token: accessToken
            }
          }
        );
        const liveVideos = liveVideosResponse.data.data || [];
        console.log(`[LIVE CHECK] Diretos ativos encontrados na página:`, JSON.stringify(liveVideos));
        
        for (const liveVideo of liveVideos) {
          const liveVideoId = liveVideo.id;
          const videoId = liveVideo.video ? liveVideo.video.id : null;
          
          if (postId.includes(liveVideoId) || (videoId && postId.includes(videoId)) || (objectId && (objectId === liveVideoId || objectId === videoId))) {
            console.log(`[LIVE CHECK] Match encontrado com o direto ativo ${liveVideoId}!`);
            return true;
          }
        }
      }
    } catch (e) {
    }

    console.log(`[LIVE CHECK] Conclusão: O post ${postId} NÃO está em direto ativo.`);
    return false;
  } catch (error) {
    console.error('[LIVE CHECK] Erro crítico no filtro de diretos:', error.message);
    return false;
  }
}

/* ─────────────────────────────────────────────
   FUNÇÕES AUXILIARES: Obtenção de Texto e Filtro de Exclusão
   ───────────────────────────────────────────── */
async function getPostMessage(postId, accessToken) {
  try {
    const response = await axios.get(
      `https://graph.facebook.com/v19.0/${postId}`,
      {
        params: {
          fields: 'message',
          access_token: accessToken
        }
      }
    );
    return response.data.message || '';
  } catch (error) {
    console.log(`⚠️ [FILTER] Não foi possível obter o texto do post ${postId}: ${error.message}`);
    return '';
  }
}

function hasExclusionWord(text) {
  if (!text) return false;
  const exclusionWords = [
    'direto', 'diretos',
    'aviso', 'avisos',
    'comunicado', 'comunicados',
    'live', 'lives',
    'esclarecimento', 'esclarecimentos',
    'informação', 'informações',
    'comunicação', 'comunicações'
  ];
  
  // Normalizar: passar para minúsculas, remover acentos e pontuação
  const cleanText = text.toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // Remove acentos
    .replace(/[.,\/#!$%\^&\*;:{}=\-_`~()?]/g, " "); // Substitui pontuação por espaço
  
  // Lista limpa de palavras de exclusão (sem acentos)
  const cleanExclusionWords = exclusionWords.map(w => 
    w.normalize("NFD").replace(/[\u0300-\u036f]/g, "")
  );
  
  const words = cleanText.split(/\s+/);
  return words.some(word => cleanExclusionWords.includes(word));
}

async function likeComment(commentId, accessToken) {
  try {
    console.log(`👍 A colocar Like no comentário ${commentId}...`);
    const response = await axios.post(
      `https://graph.facebook.com/v19.0/${commentId}/likes`,
      null,
      { params: { access_token: accessToken } }
    );
    if (response.data && response.data.success) {
      console.log(`✅ Like colocado com sucesso no comentário ${commentId}!`);
    }
  } catch (error) {
    console.error(`❌ Erro ao colocar Like no comentário ${commentId}:`);
    if (error.response && error.response.data) {
      console.error(JSON.stringify(error.response.data, null, 2));
    } else {
      console.error(error.message);
    }
  }
}

function classifyCommentAndGetReply(commentText, senderName) {
  const firstName = senderName.split(' ')[0];
  if (!commentText) {
    return {
      text: REPLY_TEMPLATE.replace('{nome}', firstName),
      isSales: true,
      type: 'sales'
    };
  }

  // Normalizar texto para análise (minúsculas, sem acentos e pontuação)
  const normalized = commentText.toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // Remove acentos
    .replace(/[.,\/#!$%\^&\*;:{}=\-_`~()?]/g, " "); // Substitui pontuação por espaço

  const words = normalized.split(/\s+/);

  // 1. Envio à Cobrança (prioridade)
  const cobrancaKeywords = ['cobranca', 'cobrar', 'reembolso', 'contrarreembolso'];
  const isCobranca = words.some(word => cobrancaKeywords.some(kw => word.startsWith(kw)));
  if (isCobranca) {
    return {
      text: `Olá ${firstName}! Não fazemos envios à cobrança. Se tiveres outra dúvida, fala connosco no Messenger: {link}`,
      isSales: false,
      type: 'cobranca'
    };
  }

  // 2. Entregas / Envios / Portes
  const entregaKeywords = ['entrega', 'entregas', 'entregam', 'envia', 'enviam', 'envio', 'envios', 'portes', 'enviar', 'entregar'];
  const isEntrega = words.some(word => entregaKeywords.includes(word));
  if (isEntrega) {
    return {
      text: `Olá ${firstName}! Sim, fazemos entregas via CTT ou via transportadora, e os portes são calculados conforme o peso. Fala connosco no Messenger: {link}`,
      isSales: false,
      type: 'entrega'
    };
  }

  // 3. Intenção de compra, reserva ou encomenda ("parecem encomendas")
  const salesKeywords = [
    'comprar', 'compra', 'compro', 'compras',
    'reservar', 'reserva', 'reservo', 'reservas',
    'encomendar', 'encomenda', 'encomendo', 'encomendas',
    'quero', 'queria', 'gostava', 'gostaria',
    'preco', 'valor', 'quanto', 'custo', 'custa',
    'tamanho', 'tamanhos', 'cor', 'cores', 'disponivel', 'medidas'
  ];
  const isSalesIntent = words.some(word => salesKeywords.some(kw => word.startsWith(kw)));
  if (isSalesIntent) {
    return {
      text: REPLY_TEMPLATE.replace('{nome}', firstName),
      isSales: true,
      type: 'sales'
    };
  }

  // 4. Mensagem simpática genérica para outros comentários
  return {
    text: `Olá ${firstName}! Muito obrigado pelo teu comentário e carinho! 🌸 Se precisares de alguma coisa, fala connosco diretamente no Messenger: {link}`,
    isSales: false,
    type: 'generic'
  };
}

/* ─────────────────────────────────────────────
   FUNÇÃO AUXILIAR: Responder ao Cliente no Messenger (Chatbot)
   ───────────────────────────────────────────── */
// Cache temporário em memória para evitar duplicações de respostas (standalone referral + message referral)
const recentReferrals = new Map();

async function handleMessengerReferral(senderId, postId, accessToken) {
  try {
    const cacheKey = `${senderId}_${postId}`;
    const now = Date.now();
    if (recentReferrals.has(cacheKey) && (now - recentReferrals.get(cacheKey) < 10000)) {
      console.log(`ℹ️ [CHATBOT] Referência recente para o post ${postId} já processada nos últimos 10 segundos para o utilizador ${senderId}. A ignorar duplicado.`);
      return;
    }
    recentReferrals.set(cacheKey, now);

    // Limpeza rápida do cache
    if (recentReferrals.size > 500) {
      for (const [key, time] of recentReferrals.entries()) {
        if (now - time > 60000) recentReferrals.delete(key);
      }
    }

    console.log(`\n🤖 [CHATBOT] A iniciar atendimento automático para PSID: ${senderId}`);
    
    if (!MESSENGER_CHATBOT_ACTIVE) {
      console.log(`ℹ️ [SILENT MODE] Chatbot desativado. Prompt de referral NÃO enviado para o cliente ${senderId}.`);
      return;
    }
    
    // 1. Construir o link do post no Facebook
    const parts = postId.split('_');
    const pageIdVal = parts[0];
    const storyFbid = parts[1] || parts[0];
    const postUrl = `https://www.facebook.com/permalink.php?story_fbid=${storyFbid}&id=${pageIdVal}`;

    // 2. Tentar obter a imagem de capa do post (full_picture)
    let pictureUrl = '';
    try {
      console.log(`🔍 [CHATBOT] A obter imagem do post ${postId}...`);
      const postDetails = await axios.get(
        `https://graph.facebook.com/v19.0/${postId}`,
        {
          params: {
            fields: 'full_picture',
            access_token: accessToken
          }
        }
      );
      pictureUrl = postDetails.data.full_picture || '';
      console.log(`📸 [CHATBOT] Imagem encontrada: ${pictureUrl}`);
    } catch (picError) {
      console.log(`⚠️ [CHATBOT] Não foi possível obter a imagem do post: ${picError.message}`);
    }

    // 3. Enviar mensagem estruturada (Generic Template) ou apenas texto se não houver imagem
    if (pictureUrl) {
      console.log(`✈️ [CHATBOT] A enviar template genérico com imagem e texto...`);
      await axios.post(
        `https://graph.facebook.com/v19.0/me/messages`,
        {
          recipient: { id: senderId },
          message: {
            attachment: {
              type: 'template',
              payload: {
                template_type: 'generic',
                elements: [
                  {
                    title: 'Completar Encomenda',
                    image_url: pictureUrl,
                    subtitle: 'Por favor, indica-nos o tamanho e a cor que pretendes para este artigo.',
                    buttons: [
                      {
                        type: 'web_url',
                        url: postUrl,
                        title: 'Ver Artigo Original'
                      }
                    ]
                  }
                ]
              }
            }
          }
        },
        { params: { access_token: accessToken } }
      );
    } else {
      console.log(`✈️ [CHATBOT] Sem imagem. A enviar apenas mensagem de texto...`);
      const chatMessage = `Olá! Viemos ajudar a completar a tua encomenda deste artigo: ${postUrl}\n\nPor favor, indica-nos:\n👉 O tamanho que desejas\n👉 A cor que preferes`;
      
      await axios.post(
        `https://graph.facebook.com/v19.0/me/messages`,
        {
          recipient: { id: senderId },
          message: { text: chatMessage }
        },
        { params: { access_token: accessToken } }
      );
    }
    
    console.log(`✅ [CHATBOT] Atendimento concluído com sucesso para o cliente ${senderId}!`);
  } catch (error) {
    console.error('❌ [CHATBOT] Erro ao responder no Messenger:', error.message);
    if (error.response && error.response.data) {
      console.error(JSON.stringify(error.response.data, null, 2));
    }
  }
}

/* ─────────────────────────────────────────────
   CHATBOT MESSENGER: Gestão de Sessões e Fluxo de Mensagens
   ───────────────────────────────────────────── */

// Gestão de sessões conversacionais para o Chatbot
const sessions = new Map();

// Função para limpar sessões inativas (expira após 2 horas)
function cleanupSessions() {
  const now = Date.now();
  const timeout = 2 * 60 * 60 * 1000; // 2 horas
  for (const [senderId, session] of sessions.entries()) {
    if (now - session.lastActive > timeout) {
      console.log(`ℹ️ [SESSÃO] Sessão de ${senderId} expirada por inatividade.`);
      sessions.delete(senderId);
    }
  }
}

// Obter nome de perfil do utilizador via API Graph do Facebook
async function getUserProfile(senderId, accessToken) {
  try {
    const response = await axios.get(`https://graph.facebook.com/v19.0/${senderId}`, {
      params: {
        fields: 'first_name,last_name',
        access_token: accessToken
      }
    });
    return response.data;
  } catch (e) {
    console.log(`⚠️ Erro ao obter perfil do utilizador ${senderId}: ${e.message}`);
    return { first_name: 'Cliente', last_name: 'Messenger' };
  }
}

// Enviar mensagem de text simples pelo Messenger
async function sendTextMessage(recipientId, text, accessToken) {
  if (!MESSENGER_CHATBOT_ACTIVE) {
    console.log(`ℹ️ [SILENT MODE] Chatbot desativado. Resposta NÃO enviada para ${recipientId}: "${text}"`);
    return;
  }
  try {
    await axios.post(
      `https://graph.facebook.com/v19.0/me/messages`,
      {
        recipient: { id: recipientId },
        message: { text: text }
      },
      { params: { access_token: accessToken } }
    );
  } catch (error) {
    console.error(`❌ Erro ao enviar mensagem para ${recipientId}:`, error.message);
    if (error.response && error.response.data) {
      console.error(JSON.stringify(error.response.data, null, 2));
    }
  }
}

// Classificar mensagens normais do cliente baseadas em intenções/palavras-chave
function classifyMessengerMessage(text) {
  if (!text) return 'default';

  // Normalizar texto para análise (minúsculas, sem acentos e pontuação)
  const normalized = text.toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[.,\/#!$%\^&\*;:{}=\-_`~()?]/g, " ");

  const words = normalized.split(/\s+/);

  // 1. Envio à cobrança
  const cobrancaKeywords = ['cobranca', 'cobrar', 'reembolso', 'contrarreembolso'];
  if (words.some(word => cobrancaKeywords.some(kw => word.startsWith(kw)))) {
    return 'cobranca';
  }

  // 2. Entregas / Envios / Portes
  const entregaKeywords = ['entrega', 'entregas', 'entregam', 'envia', 'enviam', 'envio', 'envios', 'portes', 'enviar', 'entregar', 'ctt', 'transportadora'];
  if (words.some(word => entregaKeywords.includes(word))) {
    return 'entrega';
  }

  // 3. Saudações
  const saudacaoKeywords = ['ola', 'oi', 'bom dia', 'boa tarde', 'boa noite', 'alo', 'tarde', 'noite'];
  if (words.some(word => saudacaoKeywords.includes(word))) {
    return 'saudacao';
  }

  // 4. Intenção de compra / Preço
  const salesKeywords = [
    'comprar', 'compra', 'compro', 'compras',
    'reservar', 'reserva', 'reservo', 'reservas',
    'encomendar', 'encomenda', 'encomendo', 'encomendas',
    'quero', 'queria', 'gostava', 'gostaria',
    'preco', 'valor', 'quanto', 'custo', 'custa',
    'tamanho', 'tamanhos', 'cor', 'cores', 'disponivel', 'medidas'
  ];
  if (words.some(word => salesKeywords.some(kw => word.startsWith(kw)))) {
    return 'sales';
  }

  return 'default';
}

// Obter posts publicados e anúncios da página nos últimos 7 dias
async function getPagePostsLast7Days(accessToken) {
  try {
    const response = await axios.get(`https://graph.facebook.com/v19.0/me/promotable_posts`, {
      params: {
        fields: 'id,message,full_picture,created_time,permalink_url',
        limit: 25,
        access_token: accessToken
      }
    });

    const posts = response.data.data || [];
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    
    let filteredPosts = posts.filter(post => {
      const createdTime = new Date(post.created_time).getTime();
      return createdTime >= sevenDaysAgo && post.full_picture;
    });

    if (filteredPosts.length === 0) {
      console.log('ℹ️ Sem anúncios dos últimos 7 dias com imagem. A carregar posts recentes com imagem...');
      filteredPosts = posts.filter(post => post.full_picture);
    }

    return filteredPosts.slice(0, 10);
  } catch (error) {
    console.error('❌ Erro ao obter posts da página:', error.message);
    return [];
  }
}

// Enviar carrossel de anúncios recentes no Messenger
async function sendRecentPostsCarousel(senderId, introText, accessToken) {
  if (!MESSENGER_CHATBOT_ACTIVE) {
    console.log(`ℹ️ [SILENT MODE] Chatbot desativado. Carrossel NÃO enviado para ${senderId}.`);
    return false;
  }

  try {
    const posts = await getPagePostsLast7Days(accessToken);
    if (posts.length === 0) {
      console.log(`⚠️ [CHATBOT] Sem posts recentes com imagem. A abortar carrossel.`);
      return false;
    }

    // Enviar primeiro o texto de introdução
    await sendTextMessage(senderId, introText, accessToken);

    const elements = posts.map(post => {
      let title = (post.message || 'Artigo').trim().replace(/\n/g, ' ');
      if (title.length > 70) title = title.substring(0, 67) + '...';
      
      const dateStr = new Date(post.created_time).toLocaleDateString('pt-PT', { day: '2-digit', month: '2-digit' });
      
      return {
        title: title || 'Artigo da Página',
        image_url: post.full_picture,
        subtitle: `Publicado em ${dateStr}`,
        buttons: [
          {
            type: 'postback',
            title: 'Pedir Este Artigo',
            payload: `SELECT_POST_${post.id}`
          },
          {
            type: 'web_url',
            url: post.permalink_url,
            title: 'Ver no Facebook'
          }
        ]
      };
    });

    console.log(`✈️ [CHATBOT] A enviar carrossel com ${elements.length} elementos para ${senderId}...`);
    
    await axios.post(
      `https://graph.facebook.com/v19.0/me/messages`,
      {
        recipient: { id: senderId },
        message: {
          attachment: {
            type: 'template',
            payload: {
              template_type: 'generic',
              elements: elements
            }
          }
        }
      },
      { params: { access_token: accessToken } }
    );

    console.log(`✅ [CHATBOT] Carrossel enviado com sucesso para ${senderId}!`);
    return true;
  } catch (error) {
    console.error('❌ [CHATBOT] Erro ao enviar carrossel:', error.message);
    if (error.response && error.response.data) {
      console.error(JSON.stringify(error.response.data, null, 2));
    }
    return false;
  }
}

// Tratar evento de Postback (clique em botões do carrossel)
async function handlePostback(senderId, payload, accessToken) {
  if (payload.startsWith('SELECT_POST_')) {
    const postId = payload.replace('SELECT_POST_', '');
    console.log(`🤖 [CHATBOT] Utilizador selecionou o post ${postId} via postback.`);
    
    sessions.set(senderId, {
      state: 'AWAITING_SIZE_COLOR',
      postId: postId,
      orderData: { sizeColor: '', addressContact: '' },
      lastActive: Date.now()
    });

    if (!MESSENGER_CHATBOT_ACTIVE) {
      console.log(`ℹ️ [SILENT MODE] Chatbot desativado. Mensagem de início de encomenda NÃO enviada para ${senderId}.`);
      return;
    }

    await handleMessengerReferral(senderId, postId, accessToken);
  }
}

// Processar fluxo principal de mensagens diretas
async function handleDirectMessage(senderId, messageText, accessToken) {
  cleanupSessions();
  let session = sessions.get(senderId);

  // Se o chatbot está desativado no Messenger, apenas guardamos as mensagens no DB para triagem manual na PWA
  if (!MESSENGER_CHATBOT_ACTIVE) {
    console.log(`ℹ️ [SILENT MODE] A processar mensagem recebida em modo silencioso: "${messageText}"`);
    try {
      const profile = await getUserProfile(senderId, accessToken);
      const fullName = `${profile.first_name || 'Cliente'} ${profile.last_name || 'Messenger'}`.trim();
      
      const newMsgOrder = {
        id: 'o_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
        senderId: senderId,
        name: fullName,
        message: messageText,
        receivedAt: new Date().toISOString(),
        conversationUrl: `https://business.facebook.com/latest/inbox/${senderId}`,
        product: '',
        status: 'pendente',
        notes: session ? `Referência do Post: ${session.postId}` : 'Conversa Direta'
      };
      await saveOrderToDB(newMsgOrder);
    } catch (dbError) {
      console.error('⚠️ Erro ao guardar mensagem no modo silencioso:', dbError.message);
    }
    return;
  }

  if (session) {
    if (session.state === 'AWAITING_SIZE_COLOR') {
      session.orderData.sizeColor = messageText;
      session.state = 'AWAITING_ADDRESS_CONTACT';
      session.lastActive = Date.now();
      
      const reply = "Obrigado! 📝 Agora, por favor indica-nos a tua morada para envio (ou se preferes levantar na loja) e um número de telemóvel para contacto.";
      await sendTextMessage(senderId, reply, accessToken);
      return;
    } 
    
    if (session.state === 'AWAITING_ADDRESS_CONTACT') {
      session.orderData.addressContact = messageText;
      
      // Obter nome de perfil do utilizador para registar
      const profile = await getUserProfile(senderId, accessToken);
      const fullName = `${profile.first_name || 'Cliente'} ${profile.last_name || 'Messenger'}`.trim();
      
      // Formatar URL do post
      const parts = session.postId.split('_');
      const storyFbid = parts[1] || parts[0];
      const pageIdVal = parts[0];
      const postUrl = `https://www.facebook.com/permalink.php?story_fbid=${storyFbid}&id=${pageIdVal}`;
      
      // Construir mensagem final unificada
      const consolidatedMessage = `[ENCOMENDA AUTOMÁTICA]\nArtigo: ${postUrl}\nDetalhes: ${session.orderData.sizeColor}\nContacto/Envio: ${messageText}`;
      
      const newOrder = {
        id: 'o_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
        senderId: senderId,
        name: fullName,
        message: consolidatedMessage,
        receivedAt: new Date().toISOString(),
        conversationUrl: `https://business.facebook.com/latest/inbox/${senderId}`,
        product: '',
        status: 'pendente',
        notes: `Artigo Post: ${session.postId}\nTamanho/Cor: ${session.orderData.sizeColor}\nContacto: ${messageText}`
      };
      
      // Guardar na base de dados JSON
      await saveOrderToDB(newOrder);
      
      // Limpar a sessão
      sessions.delete(senderId);
      
      // Enviar mensagem de confirmação final
      const reply = `Muito obrigado! A tua encomenda foi registada com sucesso com os seguintes dados:\n- Detalhes: ${session.orderData.sizeColor}\n- Contacto/Entrega: ${messageText}\n\nO pagamento pode ser efetuado por MB WAY ou levantamento físico na loja. Um operador irá validar a disponibilidade e enviar os detalhes de pagamento em breve. 🌸`;
      await sendTextMessage(senderId, reply, accessToken);
      return;
    }
  }

  // Se não houver sessão ativa (conversação fora de fluxo ou início)
  const intent = classifyMessengerMessage(messageText);

  if (intent === 'sales' || intent === 'saudacao' || intent === 'default') {
    if (MESSENGER_CHATBOT_ACTIVE) {
      const introText = intent === 'sales'
        ? "Olá! Para encomendar de forma rápida, seleciona em qual dos nossos artigos recentes tens interesse:"
        : "Olá! Como posso ajudar-te hoje? 😊 Se pretendes fazer uma encomenda, seleciona abaixo o artigo pretendido:";
      const sent = await sendRecentPostsCarousel(senderId, introText, accessToken);
      if (sent) return; // Carrossel enviado com sucesso! Terminar processamento.
    }
  }

  let replyText = "";
  
  switch (intent) {
    case 'cobranca':
      replyText = "Olá! Não fazemos envios à cobrança. Aceitamos pagamentos via MB WAY ou levantamento diretamente na loja física. Desejas fazer alguma encomenda?";
      break;
    case 'entrega':
      replyText = "Olá! Fazemos entregas via CTT ou transportadora, sendo os portes calculados de acordo com o peso da encomenda. Também dispomos de levantamento gratuito na nossa loja física. Desejas encomendar algum artigo?";
      break;
    case 'saudacao':
      replyText = "Olá! Como posso ajudar-te hoje? 😊 Se pretendes fazer uma encomenda, por favor partilha connosco o link ou a foto do artigo, indicando também o tamanho e a cor que pretendes. Desta forma daremos início ao pedido! 🌸";
      break;
    case 'sales':
      replyText = "Olá! Se pretendes fazer uma encomenda ou saber o preço, por favor partilha connosco a foto ou link do artigo, e indica o tamanho e a cor que pretendes. Desta forma ajudamos-te muito mais rápido! 😊";
      break;
    default:
      replyText = "Olá! Obrigado pela mensagem. Se pretendes fazer uma encomenda, por favor envia-nos o link ou foto do artigo, juntamente com o tamanho e a cor pretendidos. Um operador irá responder-te o mais breve possível. 🌸";
      break;
  }
  
  await sendTextMessage(senderId, replyText, accessToken);

  // Guardar a mensagem não-encomenda na base de dados para triagem (será colocada em "Para Rever" na PWA)
  try {
    const profile = await getUserProfile(senderId, accessToken);
    const fullName = `${profile.first_name || 'Cliente'} ${profile.last_name || 'Messenger'}`.trim();
    
    const newMsgOrder = {
      id: 'o_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
      senderId: senderId,
      name: fullName,
      message: messageText,
      receivedAt: new Date().toISOString(),
      conversationUrl: `https://business.facebook.com/latest/inbox/${senderId}`,
      product: '',
      status: 'pendente',
      notes: `Intenção detetada: ${intent}`
    };
    await saveOrderToDB(newMsgOrder);
  } catch (dbError) {
    console.error('⚠️ Erro ao salvar mensagem não-encomenda na base de dados:', dbError.message);
  }
}

/* ─────────────────────────────────────────────
   ROTAS DA API (Para integração com a PWA)
   ───────────────────────────────────────────── */

// Endpoint para a PWA ler todas as encomendas registadas
app.get('/api/orders', (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  const orders = readOrdersFromDB();
  res.json(orders);
});

// Endpoint para a PWA apagar/atualizar encomendas
app.delete('/api/orders/:id', (req, res) => {
  const { id } = req.params;
  const orders = readOrdersFromDB();
  const filtered = orders.filter(o => o.id !== id);
  
  if (orders.length === filtered.length) {
    return res.status(404).json({ error: 'Encomenda não encontrada' });
  }
  
  writeOrdersToDB(filtered);
  console.log(`🗑️ Encomenda ${id} apagada via API.`);
  res.json({ success: true });
});

// Endpoint para a PWA enviar uma mensagem manual ao cliente via API do Messenger
app.post('/api/send-message', async (req, res) => {
  const { senderId, text } = req.body;
  if (!senderId || !text) {
    return res.status(400).json({ error: 'senderId e text são obrigatórios' });
  }

  try {
    console.log(`✉️ A enviar mensagem manual para ${senderId}: "${text.substring(0, 50)}..."`);
    
    const response = await axios.post(
      `https://graph.facebook.com/v19.0/me/messages`,
      {
        recipient: { id: senderId },
        message: { text: text }
      },
      { params: { access_token: PAGE_ACCESS_TOKEN } }
    );

    if (response.data && response.data.message_id) {
      console.log(`✅ Mensagem manual enviada com sucesso para ${senderId}!`);
      return res.json({ success: true, messageId: response.data.message_id });
    }
    
    throw new Error('Sem confirmação de message_id da Meta');
  } catch (error) {
    console.error(`❌ Erro ao enviar mensagem manual para ${senderId}:`, error.message);
    if (error.response && error.response.data) {
      console.error(JSON.stringify(error.response.data, null, 2));
      return res.status(500).json({ 
        error: 'Erro na API do Facebook', 
        details: error.response.data.error ? error.response.data.error.message : error.response.data 
      });
    }
    return res.status(500).json({ error: error.message });
  }
});


/* ─────────────────────────────────────────────
   GET /webhook (Validação do Facebook)
   ───────────────────────────────────────────── */
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token) {
    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
      console.log('✅ Webhook verificado com sucesso pelo Facebook!');
      return res.status(200).send(challenge);
    } else {
      console.error('❌ Falha na verificação: Tokens não coincidem.');
      return res.sendStatus(403);
    }
  }
  res.sendStatus(400);
});

/* ─────────────────────────────────────────────
   POST /webhook (Eventos de Comentários)
   ───────────────────────────────────────────── */
app.post('/webhook', async (req, res) => {
  console.log('📥 Recebido evento Webhook do Facebook!');
  console.log(JSON.stringify(req.body, null, 2));

  const body = req.body;

  // Confirmar que o evento é de uma Página de Facebook
  if (body.object === 'page') {
    
    // Facebook pode enviar múltiplos eventos num único lote
    body.entry.forEach(entry => {
      const pageId = entry.id; // O ID da nossa página

      // --- 2.1. LÓGICA DE COMENTÁRIOS (Feed da Página) ---
      if (entry.changes) {
        entry.changes.forEach(async (change) => {
        // Apenas nos interessam alterações no feed da página
        if (change.field !== 'feed') return;

        const value = change.value;
        
        // Verificar se é um novo comentário a ser adicionado
        if (value.item === 'comment' && value.verb === 'add') {
          const commentId = value.comment_id;
          const message = value.message;
          const senderId = value.from ? value.from.id : null;
          const senderName = value.from ? value.from.name : 'Cliente';
          const parentId = value.parent_id;
          const postId = value.post_id;

          console.log(`\n💬 Novo comentário detetado!`);
          console.log(`- De: ${senderName} (ID: ${senderId})`);
          console.log(`- Conteúdo: "${message}"`);
          console.log(`- ID Comentário: ${commentId}`);

          // 1. Evitar loops: Não responder se o comentário foi feito pela própria página
          if (senderId === pageId) {
            console.log('ℹ️ Comentário feito pela própria página. A ignorar para evitar loops.');
            return;
          }

          // 2. Apenas responder a comentários de nível principal (ignorar respostas a comentários)
          // Se parent_id existir e for diferente do post_id, significa que é uma resposta a outro comentário
          if (parentId && parentId !== postId) {
            console.log('ℹ️ É uma resposta a outro comentário. A ignorar para evitar spam.');
            return;
          }

          // Colocar um Like no comentário para mostrar que foi lido (aplicável a todos os comentários de clientes, incluindo diretos e avisos)
          await likeComment(commentId, PAGE_ACCESS_TOKEN);

          // 3. Gerar a resposta personalizada com base no conteúdo do comentário
          const classification = classifyCommentAndGetReply(message, senderName);
          const isShippingOrCobranca = classification.type === 'entrega' || classification.type === 'cobranca';

          // Se não for uma pergunta sobre envios ou cobranças, aplicamos os filtros de exclusão (diretos e avisos)
          if (!isShippingOrCobranca) {
            // 2.1. Ignorar comentários se o post for um direto de vídeo ATIVO (LIVE)
            console.log(`🔍 A verificar se o post ${postId} é um direto ativo...`);
            const isLive = await isPostCurrentlyLive(postId, PAGE_ACCESS_TOKEN);
            if (isLive) {
              console.log('ℹ️ Comentário (não envios/cobrança) feito num direto ativo (LIVE). Nenhuma resposta automática enviada.');
              return;
            }

            // 2.2. Ignorar comentários se o post contiver palavras de exclusão (direto, aviso, comunicado, etc.)
            console.log(`🔍 A verificar se o post ${postId} contém palavras de exclusão no texto...`);
            const postText = await getPostMessage(postId, PAGE_ACCESS_TOKEN);
            if (postText) {
              const hasExclusion = hasExclusionWord(postText);
              if (hasExclusion) {
                console.log(`ℹ️ Post ignorado por conter palavra de exclusão (direto, aviso, comunicado, etc.). Conteúdo: "${postText.substring(0, 100)}..."`);
                return;
              }
            }
          } else {
            console.log(`ℹ️ Pergunta de envios/cobrança detetada ("${classification.type}"). Ignorando filtros de exclusão e diretos para responder.`);
          }

          let replyText = classification.text;

          // Gerar o link m.me correspondente
          try {
            const PAGE_USERNAME = process.env.PAGE_USERNAME || 'BySandraSilveira';
            let mmeLink = '';

            if (classification.isSales) {
              // Link especializado com referência do post e texto pré-preenchido
              const prefilledText = 'Olá! Quero encomendar este artigo.';
              const encodedText = encodeURIComponent(prefilledText);
              mmeLink = `https://m.me/${PAGE_USERNAME}?ref=${postId}&text=${encodedText}`;
            } else {
              // Link básico do Messenger da página, sem indicação do artigo
              mmeLink = `https://m.me/${PAGE_USERNAME}`;
            }

            if (replyText.includes('{link}')) {
              replyText = replyText.replace('{link}', mmeLink);
            } else {
              replyText = `${replyText}\n\n👉 Fala connosco: ${mmeLink}`;
            }
          } catch (linkError) {
            console.error('[LINK GENERATOR] Erro ao gerar link personalizado:', linkError.message);
          }

          // 4. Enviar a resposta via API Graph do Facebook
          try {
            console.log(`✈️ A enviar resposta pública para o comentário ${commentId}...`);
            
            const response = await axios.post(
              `https://graph.facebook.com/v19.0/${commentId}/comments`,
              { message: replyText },
              { params: { access_token: PAGE_ACCESS_TOKEN } }
            );

            console.log(`✅ Resposta enviada! ID da Resposta: ${response.data.id}`);
          } catch (error) {
            console.error('❌ Erro ao enviar resposta para o Facebook:');
            if (error.response && error.response.data) {
              console.error(JSON.stringify(error.response.data, null, 2));
            } else {
              console.error(error.message);
            }
          }
        }
        });
      }

      // --- 2.2. LÓGICA DE ATENDIMENTO AUTOMÁTICO (Chatbot do Messenger) ---
      if (entry.messaging) {
        entry.messaging.forEach(async (messagingEvent) => {
          console.log(`📥 [MESSAGING] Recebido evento no Messenger:`, JSON.stringify(messagingEvent, null, 2));
          const senderId = messagingEvent.sender ? messagingEvent.sender.id : null;
          if (!senderId) return;

          // 1. Ignorar mensagens eco (mensagens enviadas pela própria página)
          if (messagingEvent.message && messagingEvent.message.is_echo) {
            console.log('ℹ️ [MESSAGING] Mensagem eco (enviada pela página). A ignorar.');
            return;
          }

          // 2. Verificar se há uma referência (referral) de link m.me no evento
          let ref = null;
          if (messagingEvent.referral && messagingEvent.referral.ref) {
            ref = messagingEvent.referral.ref;
          } else if (messagingEvent.postback && messagingEvent.postback.referral && messagingEvent.postback.referral.ref) {
            ref = messagingEvent.postback.referral.ref;
          } else if (messagingEvent.message && messagingEvent.message.referral && messagingEvent.message.referral.ref) {
            ref = messagingEvent.message.referral.ref;
          }

          if (ref) {
            console.log(`\n💬 Novo cliente entrou via link de referência no Messenger!`);
            console.log(`- Cliente PSID: ${senderId}`);
            console.log(`- ID do Post de Referência: ${ref}`);

            // Inicializar sessão conversacional para este utilizador
            sessions.set(senderId, {
              state: 'AWAITING_SIZE_COLOR',
              postId: ref,
              orderData: { sizeColor: '', addressContact: '' },
              lastActive: Date.now()
            });

            // Enviar imagem e solicitar cor/tamanho
            await handleMessengerReferral(senderId, ref, PAGE_ACCESS_TOKEN);
          } else if (messagingEvent.postback && messagingEvent.postback.payload) {
            // Utilizador clicou num botão de postback (como no carrossel)
            const payload = messagingEvent.postback.payload;
            console.log(`📥 [POSTBACK] Recebido Postback no Messenger: ${payload}`);
            await handlePostback(senderId, payload, PAGE_ACCESS_TOKEN);
          } else if (messagingEvent.message && messagingEvent.message.text) {
            // Mensagem de texto normal do utilizador
            const messageText = messagingEvent.message.text.trim();
            await handleDirectMessage(senderId, messageText, PAGE_ACCESS_TOKEN);
          }
        });
      }
    });

    // Responder ao Facebook com 200 OK para confirmar receção do evento
    return res.status(200).send('EVENT_RECEIVED');
  }

  // Se não for um objeto de página
  res.sendStatus(404);
});

// Rota padrão para teste rápido
app.get('/', (req, res) => {
  res.send('🤖 Facebook Comment Bot está a funcionar localmente!');
});

/* ─────────────────────────────────────────────
   FUNÇÃO AUXILIAR: Subscrever Página de Forma Automática
   ───────────────────────────────────────────── */
async function autoSubscribePage() {
  if (!PAGE_ACCESS_TOKEN || PAGE_ACCESS_TOKEN === 'O_TEU_PAGE_ACCESS_TOKEN_AQUI') {
    console.log('ℹ️ [AUTO-SUBSCRIBE] Token de página não configurado ou padrão. A ignorar auto-subscrição.');
    return;
  }
  try {
    console.log('🔗 [AUTO-SUBSCRIBE] A tentar subscrever a página na aplicação da Meta...');
    const response = await axios.post(
      `https://graph.facebook.com/v19.0/me/subscribed_apps`,
      null,
      {
        params: {
          subscribed_fields: 'feed,messages,messaging_postbacks,messaging_referrals',
          access_token: PAGE_ACCESS_TOKEN
        }
      }
    );
    if (response.data && response.data.success) {
      console.log('✅ [AUTO-SUBSCRIBE] Página subscrita com sucesso para: feed, messages, messaging_postbacks, messaging_referrals!');
    } else {
      console.log('⚠️ [AUTO-SUBSCRIBE] Resposta inesperada ao subscrever:', response.data);
    }
  } catch (error) {
    console.error('❌ [AUTO-SUBSCRIBE] Erro ao subscrever página de forma automática:');
    if (error.response && error.response.data) {
      console.error(JSON.stringify(error.response.data, null, 2));
    } else {
      console.error(error.message);
    }
  }
}

/* ─────────────────────────────────────────────
   INICIAR SERVIDOR
   ───────────────────────────────────────────── */
app.listen(PORT, async () => {
  console.log(`\n🚀 Servidor do Bot iniciado com sucesso na porta ${PORT}`);
  console.log(`- Webhook URL local: http://localhost:${PORT}/webhook`);
  console.log(`- Monitorizando comentários no feed da página...`);
  
  // Subscrever a página automaticamente às permissões de webhook
  await autoSubscribePage();
});
