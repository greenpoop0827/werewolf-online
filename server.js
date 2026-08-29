const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

app.use(express.static(path.join(__dirname, "public")));

const rooms = {};
const roomNightTimeouts = {};

function getDefaultRoomState(roomId, hostId) {
  return {
    roomId,
    hostId: hostId || null,
    started: false,
    gameOver: false,
    winner: null,
    winRule: "side",
    witchSelfSaveFirstNight: true,
    dayCount: 0,
    phase: "LOBBY",
    enableSheriff: true,
    sheriff: null,

    sheriffRound: 1,
    sheriffDecisions: {},
    sheriffCandidates: [],
    sheriffWithdrawn: [],
    sheriffTieCandidates: [],
    sheriffLastSpeakQueue: [],
    sheriffCallTarget: null,

    dayPkRound: 1,
    dayPkCandidates: [],
    dayDiscussClockwise: true,

    pendingDeathSeats: [],
    pendingDeathQueue: [],
    firstNightLastWordsQueue: [],
    currentLastWordSeat: null,
    postDeathHandler: null,
    activeDeathSeat: null,
    hunterDeathReason: {},

    players: [],
    wolfTargets: {},
    wolfChatHistory: [],
    spectatorLogs: [],

    guardTarget: null,
    lastGuardTarget: null,

    witchAntidoteUsed: false,
    witchPoisonUsed: false,
    witchSaveThisNight: false,
    witchPoisonThisNight: null,

    seerCheckLog: null,
    lastKilled: null,
    speakingQueue: [],
    speakerIdx: 0,
    speakerStartTime: null,
    votes: {},
    exiledPlayer: null,
    logs: [],
    lastActiveTime: Date.now()
  };
}

function getSanitizedState(state, targetPlayer) {
  const isSpectator = targetPlayer && targetPlayer.isSpectator;
  const role = targetPlayer ? targetPlayer.role : null;
  const isWolfTeam = ["狼人", "白狼王"].includes(role);

  if (isSpectator) {
    return state;
  }

  const safeState = JSON.parse(JSON.stringify(state));

  if (!state.gameOver) {
    safeState.players = safeState.players.map(p => {
      if (targetPlayer && p.id === targetPlayer.id) return p;
      if (p.idiotRevealed) return p;
      if (isWolfTeam && ["狼人", "白狼王"].includes(p.role)) return p;
      return { ...p, role: null };
    });
  }

  if (!state.gameOver) {
    if (!isWolfTeam) {
      safeState.wolfTargets = {};
      safeState.wolfChatHistory = [];
    }
    if (role !== "女巫") {
      safeState.witchSaveThisNight = false;
      safeState.witchPoisonThisNight = null;
    }
    if (role !== "預言家") {
      safeState.seerCheckLog = null;
    }
    if (role !== "守衛") {
      safeState.guardTarget = null;
      safeState.lastGuardTarget = null;
    }
    if (["NIGHT_GUARD", "NIGHT_WOLF", "NIGHT_WITCH", "NIGHT_SEER"].includes(state.phase)) {
      if (role !== "女巫" || state.witchAntidoteUsed) {
        safeState.lastKilled = null;
      }
    }
    safeState.spectatorLogs = [];
  }

  return safeState;
}

function broadcastRoomState(roomId) {
  const state = rooms[roomId];
  if (!state) return;
  state.lastActiveTime = Date.now();

  state.players.forEach(p => {
    const sanitized = getSanitizedState(state, p);
    io.to(p.socketId).emit("STATE_UPDATE", sanitized);
  });
}

function emitTTS(roomId, text) {
  io.to(roomId).emit("TTS_ANNOUNCE", text);
}

function logRoom(state, msg) {
  state.logs.push(msg);
  logSpectator(state, msg);
}

function logSpectator(state, msg) {
  state.spectatorLogs.push(`[第 ${state.dayCount} 天] ${msg}`);
}

function reorderSeats(state) {
  if (state.started) return;
  let seatNum = 1;
  state.players.forEach(p => {
    if (!p.isSpectator) {
      p.seat = seatNum++;
    } else {
      p.seat = null;
    }
  });
}

function checkGameOver(state) {
  const alivePlayers = state.players.filter(p => !p.isSpectator && p.alive);
  const aliveWolves = alivePlayers.filter(p => ["狼人", "白狼王"].includes(p.role));
  const aliveGods = alivePlayers.filter(p => ["預言家", "女巫", "獵人", "白痴", "守衛"].includes(p.role));
  const aliveVillagers = alivePlayers.filter(p => p.role === "村民");

  if (aliveWolves.length === 0) {
    state.gameOver = true;
    state.winner = "好人陣營";
    logRoom(state, "所有狼人均已出局，【好人陣營獲勝】！遊戲結束。");
    emitTTS(state.roomId, "遊戲結束，好人陣營獲勝！");
    return true;
  }

  if (state.winRule === "all") {
    if (aliveGods.length === 0 && aliveVillagers.length === 0) {
      state.gameOver = true;
      state.winner = "狼人陣營";
      logRoom(state, "好人陣營全數出局（屠城成功），【狼人陣營獲勝】！遊戲結束。");
      emitTTS(state.roomId, "遊戲結束，狼人陣營獲勝！");
      return true;
    }
  } else {
    if (aliveGods.length === 0) {
      state.gameOver = true;
      state.winner = "狼人陣營";
      logRoom(state, "神職陣營全數出局（屠神成功），【狼人陣營獲勝】！遊戲結束。");
      emitTTS(state.roomId, "遊戲結束，狼人陣營獲勝！");
      return true;
    }
    if (aliveVillagers.length === 0) {
      state.gameOver = true;
      state.winner = "狼人陣營";
      logRoom(state, "平民陣營全數出局（屠民成功），【狼人陣營獲勝】！遊戲結束。");
      emitTTS(state.roomId, "遊戲結束，狼人陣營獲勝！");
      return true;
    }
  }
  return false;
}

function clearNightTimer(roomId) {
  if (roomNightTimeouts[roomId]) {
    clearTimeout(roomNightTimeouts[roomId]);
    delete roomNightTimeouts[roomId];
  }
}

function advanceNightStep(state, currentPhase) {
  clearNightTimer(state.roomId);
  const hasRole = (roleName) => state.players.some(p => !p.isSpectator && p.role === roleName);

  if (currentPhase === "START") {
    if (hasRole("守衛")) {
      enterNightPhase(state, "NIGHT_GUARD");
    } else {
      advanceNightStep(state, "NIGHT_GUARD");
    }
    return;
  }

  if (currentPhase === "NIGHT_GUARD") {
    enterNightPhase(state, "NIGHT_WOLF");
    return;
  }

  if (currentPhase === "NIGHT_WOLF") {
    if (hasRole("女巫")) {
      enterNightPhase(state, "NIGHT_WITCH");
    } else {
      advanceNightStep(state, "NIGHT_WITCH");
    }
    return;
  }

  if (currentPhase === "NIGHT_WITCH") {
    if (hasRole("預言家")) {
      enterNightPhase(state, "NIGHT_SEER");
    } else {
      advanceNightStep(state, "NIGHT_SEER");
    }
    return;
  }

  if (currentPhase === "NIGHT_SEER") {
    finishNight(state);
  }
}

function enterNightPhase(state, phaseName) {
  clearNightTimer(state.roomId);
  state.phase = phaseName;
  state.speakerStartTime = null;

  const DEAD_GOD_WAIT_MS = 8000;

  if (phaseName === "NIGHT_GUARD") {
    emitTTS(state.roomId, "守衛請睜眼。");
    const guardAlive = state.players.some(p => !p.isSpectator && p.role === "守衛" && p.alive);
    if (!guardAlive) {
      roomNightTimeouts[state.roomId] = setTimeout(() => {
        logSpectator(state, "守衛已出局，模擬時間結束，推進至下一階段。");
        advanceNightStep(state, "NIGHT_GUARD");
        broadcastRoomState(state.roomId);
      }, DEAD_GOD_WAIT_MS);
    }
  } else if (phaseName === "NIGHT_WOLF") {
    emitTTS(state.roomId, "狼人請睜眼。");
    // 🌟 進入狼人階段時，強制清空上一輪殘留的投票紀錄
    state.wolfTargets = {};
    const trulyAliveWolves = state.players.filter(p => !p.isSpectator && ["狼人", "白狼王"].includes(p.role) && p.alive);
    if (trulyAliveWolves.length === 0) {
      roomNightTimeouts[state.roomId] = setTimeout(() => {
        logSpectator(state, "存活狼人為0，模擬時間結束，推進至下一階段。");
        advanceNightStep(state, "NIGHT_WOLF");
        broadcastRoomState(state.roomId);
      }, DEAD_GOD_WAIT_MS);
    }
  } else if (phaseName === "NIGHT_WITCH") {
    emitTTS(state.roomId, "女巫請睜眼。");
    const witchAlive = state.players.some(p => !p.isSpectator && p.role === "女巫" && p.alive);
    if (!witchAlive) {
      roomNightTimeouts[state.roomId] = setTimeout(() => {
        logSpectator(state, "女巫已出局，模擬時間結束，推進至下一階段。");
        advanceNightStep(state, "NIGHT_WITCH");
        broadcastRoomState(state.roomId);
      }, DEAD_GOD_WAIT_MS);
    }
  } else if (phaseName === "NIGHT_SEER") {
    emitTTS(state.roomId, "預言家請睜眼。");
    const seerAlive = state.players.some(p => !p.isSpectator && p.role === "預言家" && p.alive);
    if (!seerAlive) {
      roomNightTimeouts[state.roomId] = setTimeout(() => {
        logSpectator(state, "預言家已出局，模擬時間結束，天亮。");
        finishNight(state);
        broadcastRoomState(state.roomId);
      }, DEAD_GOD_WAIT_MS);
    }
  }
}

function startNight(state) {
  if (checkGameOver(state)) return;
  state.dayCount++;
  state.guardTarget = null;
  state.wolfTargets = {}; // 🌟 每晚入夜清空狼人投票
  state.witchSaveThisNight = false;
  state.witchPoisonThisNight = null;
  state.lastKilled = null;
  state.seerCheckLog = null;
  state.sheriffCallTarget = null;
  state.dayPkRound = 1;
  state.dayPkCandidates = [];
  state.sheriffDecisions = {};

  logRoom(state, "天黑請閉眼。");
  emitTTS(state.roomId, "天黑請閉眼。");
  logSpectator(state, `=== 第 ${state.dayCount} 夜開始 ===`);

  advanceNightStep(state, "START");
}

function finishNight(state) {
  clearNightTimer(state.roomId);
  let deadSeats = [];
  state.hunterDeathReason = {};

  state.players.forEach(p => {
    if (p.explodedThisDay) p.explodedThisDay = false;
  });

  const wolfTarget = state.lastKilled;
  const isGuarded = state.guardTarget && state.guardTarget === wolfTarget;
  const isSaved = state.witchSaveThisNight;

  if (wolfTarget && wolfTarget > 0) {
    if (isGuarded && isSaved) {
      deadSeats.push(wolfTarget);
      state.hunterDeathReason[wolfTarget] = "wolf";
      logRoom(state, `（系統提示：昨夜有人同守同救奶穿身亡）`);
    } else if (!isGuarded && !isSaved) {
      deadSeats.push(wolfTarget);
      state.hunterDeathReason[wolfTarget] = "wolf";
    }
  }

  if (state.witchPoisonThisNight) {
    if (!deadSeats.includes(state.witchPoisonThisNight)) {
      deadSeats.push(state.witchPoisonThisNight);
    }
    state.hunterDeathReason[state.witchPoisonThisNight] = "witch";
  }

  deadSeats.sort((a, b) => a - b);
  state.pendingDeathSeats = deadSeats;

  if (state.enableSheriff && !state.sheriff && state.dayCount === 1) {
    state.phase = "DAY_SHERIFF_RUN";
    state.sheriffCandidates = [];
    state.sheriffWithdrawn = [];
    state.sheriffDecisions = {};
    logRoom(state, `=== 第 ${state.dayCount} 天天亮。先進行警長競選（死訊尚未公佈） ===`);
    emitTTS(state.roomId, "天亮了，現在開始警長競選，請選擇是否上警。");
  } else {
    announceDeathAndStartDay(state);
  }
}

function announceDeathAndStartDay(state) {
  state.pendingDeathSeats.forEach(seat => {
    const p = state.players.find(pl => !pl.isSpectator && pl.seat === seat);
    if (p) p.alive = false;
  });

  state.pendingDeathSeats.sort((a, b) => a - b);
  const deathNotice = state.pendingDeathSeats.length > 0
    ? `${state.pendingDeathSeats.join(", ")} 號（死亡不分先後順序）`
    : "平安夜";

  logRoom(state, `=== 第 ${state.dayCount} 天死訊公佈：昨晚出局：${deathNotice} ===`);

  if (state.pendingDeathSeats.length > 0) {
    emitTTS(state.roomId, `天亮了，昨晚出局的是 ${state.pendingDeathSeats.join(" 號、")} 號玩家。`);
  } else {
    emitTTS(state.roomId, "天亮了，昨晚是平安夜。");
  }

  if (checkGameOver(state)) return;

  state.postDeathHandler = "START_DAY_PROCESS";

  if (state.dayCount === 1 && state.pendingDeathSeats.length > 0) {
    state.firstNightLastWordsQueue = [...state.pendingDeathSeats];
    processFirstNightLastWords(state);
  } else {
    state.pendingDeathQueue = [...state.pendingDeathSeats];
    if (state.pendingDeathQueue.length > 0) {
      processNextDeathQueue(state);
    } else {
      processPostDeathStep(state);
    }
  }
}

function processFirstNightLastWords(state) {
  if (state.firstNightLastWordsQueue.length > 0) {
    const nextSeat = state.firstNightLastWordsQueue.shift();
    state.currentLastWordSeat = nextSeat;
    state.phase = "DAY_NIGHT_LAST_WORDS";
    logRoom(state, `請首夜出局玩家 ${nextSeat} 號發表遺言。`);
    emitTTS(state.roomId, `請 ${nextSeat} 號玩家發表遺言。`);
  } else {
    state.currentLastWordSeat = null;
    state.pendingDeathQueue = [...state.pendingDeathSeats];
    if (state.pendingDeathQueue.length > 0) {
      processNextDeathQueue(state);
    } else {
      processPostDeathStep(state);
    }
  }
}

function processNextDeathQueue(state) {
  if (state.pendingDeathQueue.length > 0) {
    const nextDead = state.pendingDeathQueue.shift();
    state.activeDeathSeat = nextDead;
    state.phase = "DEATH_SKILL_CHECK";
    emitTTS(state.roomId, `請 ${nextDead} 號玩家確認出局操作。`);
  } else {
    processPostDeathStep(state);
  }
}

function processPostDeathStep(state) {
  const deadSheriff = state.players.find(p => p.isSheriff && !p.alive);
  if (deadSheriff) {
    state.phase = "SHERIFF_TRANSFER";
    logRoom(state, `警長 ${deadSheriff.seat} 號出局，請移交或撕毀警徽。`);
    emitTTS(state.roomId, "警長出局，請移交或撕毀警徽。");
    return;
  }

  if (state.postDeathHandler === "START_NIGHT") {
    startNight(state);
  } else if (state.postDeathHandler === "START_DAY_PROCESS") {
    startDayProcess(state);
  }
}

function electSheriff(state, seat, reason) {
  const p = state.players.find(pl => !pl.isSpectator && pl.seat === seat);
  p.isSheriff = true;
  state.sheriff = seat;
  logRoom(state, `${seat} 號當選警長！（${reason}）`);
  emitTTS(state.roomId, `${seat} 號玩家當選警長。`);

  if (state.dayCount === 1 && state.players.filter(pl => !pl.isSpectator && !pl.alive).length === 0) {
    announceDeathAndStartDay(state);
  } else {
    startDayProcess(state);
  }
}

function startDayProcess(state) {
  const aliveSheriff = state.players.find(p => !p.isSpectator && p.isSheriff && p.alive);

  if (aliveSheriff) {
    state.phase = "DAY_ORDER_CHOOSE";
    logRoom(state, `請警長 ${aliveSheriff.seat} 號決定發言順序。`);
    emitTTS(state.roomId, "請警長決定發言順序。");
  } else {
    const alivePlayers = state.players.filter(p => !p.isSpectator && p.alive);
    const randStart = alivePlayers[Math.floor(Math.random() * alivePlayers.length)].seat;
    logRoom(state, `無警長，系統隨機選定從 ${randStart} 號開始順時針發言。`);
    state.dayDiscussClockwise = true;
    setupDiscussQueue(state, randStart, true);
  }
}

function setupDiscussQueue(state, startSeat, clockwise) {
  const aliveSeats = state.players.filter(p => !p.isSpectator && p.alive).map(p => p.seat);
  const total = state.players.filter(p => !p.isSpectator).length;
  const queue = [];

  let cur = startSeat;
  for (let i = 0; i < total; i++) {
    if (aliveSeats.includes(cur)) queue.push(cur);
    cur = clockwise ? (cur % total) + 1 : (cur === 1 ? total : cur - 1);
  }

  state.speakingQueue = queue;
  state.speakerIdx = 0;
  state.speakerStartTime = Date.now();
  state.phase = "DAY_DISCUSS";
  logRoom(state, `發言順序已確立：從 ${startSeat} 號開始（${clockwise ? "順時針" : "逆時針"}）：${queue.join(" -> ")} 號。`);
  emitTTS(state.roomId, `請 ${queue[0]} 號玩家開始發言。`);
}

function startDayVote(state) {
  state.phase = "DAY_VOTE";
  state.speakerStartTime = null;
  state.votes = {};
  logRoom(state, "進入白天放逐公投，請存活且未翻牌玩家投票。");
  emitTTS(state.roomId, "請大家開始投票。");
}

function tallyVotes(state) {
  const isSheriffVote = state.phase === "DAY_SHERIFF_VOTE";
  const count = {};
  let voteDetails = [];

  for (let voterSeat in state.votes) {
    const targetSeat = state.votes[voterSeat];
    const voter = state.players.find(p => !p.isSpectator && p.seat === Number(voterSeat));
    const weight = (!isSheriffVote && voter && voter.isSheriff) ? 1.5 : 1.0;

    if (targetSeat !== 0) {
      count[targetSeat] = (count[targetSeat] || 0) + weight;
      voteDetails.push(`${voterSeat}號${voter && voter.isSheriff ? '(警長)' : ''} -> ${targetSeat}號 (${weight}票)`);
    } else {
      voteDetails.push(`${voterSeat}號 -> 棄票`);
    }
  }

  logRoom(state, `【開票詳情】：\n` + voteDetails.join("\n"));

  let maxSeat = null, maxCount = 0, isTie = false, tieSeats = [];
  for (let s in count) {
    if (count[s] > maxCount) {
      maxCount = count[s];
      maxSeat = Number(s);
      isTie = false;
      tieSeats = [Number(s)];
    } else if (count[s] === maxCount && maxCount > 0) {
      isTie = true;
      tieSeats.push(Number(s));
    }
  }

  if (isSheriffVote) {
    if (maxSeat && !isTie) {
      electSheriff(state, maxSeat, `以 ${maxCount} 票當選`);
    } else {
      if (state.sheriffRound === 1 && isTie) {
        state.sheriffRound = 2;
        state.sheriffTieCandidates = tieSeats;
        state.sheriffCandidates = [...tieSeats];
        state.phase = "DAY_SHERIFF_SPEAK";

        const reversedTieQueue = state.sheriffLastSpeakQueue.filter(s => tieSeats.includes(s)).reverse();
        state.speakingQueue = reversedTieQueue;
        state.sheriffLastSpeakQueue = [...reversedTieQueue];
        state.speakerIdx = 0;
        state.speakerStartTime = Date.now();
        logRoom(state, `警長競選平票（${tieSeats.join(", ")} 號）！現在進入 PK 階段，依反方向再次發言：${reversedTieQueue.join(" -> ")} 號。`);
        emitTTS(state.roomId, `警長競選 ${tieSeats.join(" 號、")} 號平票，現在進入 PK 階段。請 ${reversedTieQueue[0]} 號玩家發言。`);
      } else if (state.sheriffRound === 2 && isTie) {
        state.sheriffRound = 3;
        state.sheriffTieCandidates = tieSeats;
        state.phase = "DAY_SHERIFF_SPEAK";

        const otherSpeakers = state.players.filter(p => !p.isSpectator && p.alive && !tieSeats.includes(p.seat)).map(p => p.seat);
        state.speakingQueue = otherSpeakers;
        state.speakerIdx = 0;
        state.speakerStartTime = Date.now();
        logRoom(state, `警長競選再次平票（${tieSeats.join(", ")} 號）！進入大眾發言輪。`);
        emitTTS(state.roomId, `再次平票，進入大眾發言輪，請 ${otherSpeakers[0]} 號玩家發言。`);
      } else {
        logRoom(state, "警長再度平票（或全體棄票），警徽流失，本局無警長！");
        emitTTS(state.roomId, "警長平票，警徽流失，本局無警長。");
        announceDeathAndStartDay(state);
      }
    }
  } else {
    if (maxSeat && !isTie) {
      const exiled = state.players.find(p => !p.isSpectator && p.seat === maxSeat);

      if (exiled.role === "白痴" && !exiled.idiotRevealed) {
        exiled.idiotRevealed = true;
        logRoom(state, `【白痴翻牌免死】${maxSeat} 號是【白痴】！翻牌免除本次放逐，繼續存活在場，但失去投票權！`);
        emitTTS(state.roomId, `${maxSeat} 號是白痴，翻牌免死存活，但失去投票權！`);

        if (exiled.isSheriff) {
          state.postDeathHandler = "START_NIGHT";
          state.phase = "SHERIFF_TRANSFER";
          logRoom(state, `白痴警長被投票放逐，雖免死但必須移交或撕毀警徽！`);
          emitTTS(state.roomId, "白痴警長被投票放逐，請移交或撕毀警徽。");
        } else {
          startNight(state);
        }
        return;
      }

      exiled.alive = false;
      state.exiledPlayer = exiled;
      state.phase = "DAY_LAST_WORDS";
      logRoom(state, `${maxSeat} 號玩家出局（以 ${maxCount} 票被放逐），請發表遺言。`);
      emitTTS(state.roomId, `${maxSeat} 號玩家出局，請發表遺言。`);
      checkGameOver(state);
    } else {
      if (state.phase === "DAY_VOTE" && isTie && tieSeats.length > 0) {
        state.dayPkRound = 2;
        state.dayPkCandidates = tieSeats;
        state.phase = "DAY_PK_SPEAK";

        const total = state.players.filter(p => !p.isSpectator).length;
        const reverseClockwise = !state.dayDiscussClockwise;
        const startSeat = tieSeats[0];
        const pkQueue = [];

        let cur = startSeat;
        for (let i = 0; i < total; i++) {
          if (tieSeats.includes(cur)) pkQueue.push(cur);
          cur = reverseClockwise ? (cur % total) + 1 : (cur === 1 ? total : cur - 1);
        }

        state.speakingQueue = pkQueue;
        state.speakerIdx = 0;
        state.speakerStartTime = Date.now();
        logRoom(state, `公投平票（${tieSeats.join(", ")} 號）！現在進入 PK 階段，依反方向發言：${pkQueue.join(" -> ")} 號。`);
        emitTTS(state.roomId, `${tieSeats.join(" 號、")} 號平票，現在進入 PK 階段。請 ${pkQueue[0]} 號玩家發言。`);
      } else {
        logRoom(state, "公投再次平票（或無有效票），本日無人出局，直接進入黑夜。");
        emitTTS(state.roomId, "公投平票，本日無人出局，直接進入黑夜。");
        startNight(state);
      }
    }
  }
}

io.on("connection", (socket) => {
  socket.on("CREATE_ROOM", ({ roomId, userId, name, isSpectator }) => {
    if (rooms[roomId] && rooms[roomId].players.length > 0) {
      socket.emit("ENTRY_ERROR", `房間號 ${roomId} 已被佔用，請更換一個房號！`);
      return;
    }

    const state = getDefaultRoomState(roomId, userId);
    rooms[roomId] = state;

    const player = {
      id: userId,
      socketId: socket.id,
      name: name || `房主_${userId.slice(-4)}`,
      seat: isSpectator ? null : 1,
      role: null,
      alive: true,
      explodedThisDay: false,
      isSheriff: false,
      idiotRevealed: false,
      isSpectator: !!isSpectator,
      online: true,
      lastDisconnectAt: null
    };

    state.players.push(player);
    logRoom(state, `房主 ${player.name} 創建了房間 ${roomId} ${isSpectator ? '（旁觀上帝視角）' : '（1號位）'}`);

    socket.join(roomId);
    socket.emit("ENTRY_SUCCESS", { roomId, isHost: true });
    broadcastRoomState(roomId);
  });

  socket.on("JOIN_ROOM", ({ roomId, userId, name, isSpectator }) => {
    const state = rooms[roomId];
    if (!state) {
      socket.emit("ENTRY_ERROR", `找不到房間號 ${roomId}，請確認房號是否正確或由房主先建立房間！`);
      return;
    }

    let player = state.players.find(p => p.id === userId);
    if (!player) {
      // 🌟 遊戲進行中：僅允許觀眾中途加入
      if (state.started) {
        if (!isSpectator) {
          socket.emit("ENTRY_ERROR", "該房間遊戲已在進行中！若想觀戰，請勾選「僅以觀眾身分觀戰」。");
          return;
        }

        // 建立觀眾物件
        player = {
          id: userId,
          socketId: socket.id,
          name: name || `觀眾_${userId.slice(-4)}`,
          seat: null,
          role: null,
          alive: true,
          explodedThisDay: false,
          isSheriff: false,
          idiotRevealed: false,
          isSpectator: true,
          online: true,
          lastDisconnectAt: null
        };
        state.players.push(player);
        logRoom(state, `${player.name} 中途加入觀戰（觀眾席）。`);
      } else {
        // 遊戲尚未開始：正常入座或加入觀眾席
        const gamePlayers = state.players.filter(p => !p.isSpectator);
        player = {
          id: userId,
          socketId: socket.id,
          name: name || `玩家_${userId.slice(-4)}`,
          seat: isSpectator ? null : gamePlayers.length + 1,
          role: null,
          alive: true,
          explodedThisDay: false,
          isSheriff: false,
          idiotRevealed: false,
          isSpectator: !!isSpectator,
          online: true,
          lastDisconnectAt: null
        };
        state.players.push(player);
        logRoom(state, `${player.name} 加入了房間 ${player.isSpectator ? '（觀眾席）' : `（${player.seat}號位）`}`);
      }
    } else {
      // 既有玩家或觀眾重連
      player.socketId = socket.id;
      player.online = true;
      player.lastDisconnectAt = null;
      if (name && !state.started) player.name = name;
      logRoom(state, `${player.name}（${player.seat ? player.seat + '號' : '觀眾'}）已重新連線。`);
    }

    socket.join(roomId);
    socket.emit("ENTRY_SUCCESS", { roomId, isHost: state.hostId === userId });
    broadcastRoomState(roomId);
  });

  socket.on("LEAVE_ROOM", ({ roomId, userId }) => {
    const state = rooms[roomId];
    if (!state) return;

    const playerIndex = state.players.findIndex(p => p.id === userId);
    if (playerIndex === -1) return;
    const player = state.players[playerIndex];

    if (!state.started) {
      state.players.splice(playerIndex, 1);
      reorderSeats(state);
      logRoom(state, `${player.name} 離開了房間。`);

      if (state.hostId === userId) {
        state.hostId = state.players.length > 0 ? state.players[0].id : null;
      }

      socket.leave(roomId);

      if (state.players.length === 0) {
        clearNightTimer(roomId);
        delete rooms[roomId];
        return;
      }
    } else {
      player.online = false;
      player.lastDisconnectAt = Date.now();
      logRoom(state, `${player.name}（${player.seat}號）離線。`);
      socket.leave(roomId);
    }

    broadcastRoomState(roomId);
  });

  socket.on("SEND_WOLF_CHAT", ({ roomId, userId, message }) => {
    const state = rooms[roomId];
    if (!state || !state.started) return;

    if (state.phase !== "NIGHT_WOLF") return;

    const sender = state.players.find(p => p.id === userId);
    if (!sender) return;

    const isWolf = ["狼人", "白狼王"].includes(sender.role);
    const canChat = sender.alive || sender.explodedThisDay;

    if (isWolf && canChat && message && message.trim()) {
      const chatItem = {
        senderSeat: sender.seat,
        senderName: sender.name,
        role: sender.role,
        message: message.trim(),
        time: new Date().toLocaleTimeString('zh-TW', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
      };
      if (!state.wolfChatHistory) state.wolfChatHistory = [];
      state.wolfChatHistory.push(chatItem);

      state.players.forEach(p => {
        if (p.isSpectator || ["狼人", "白狼王"].includes(p.role)) {
          io.to(p.socketId).emit("RECEIVE_WOLF_CHAT", chatItem);
        }
      });
    }
  });

  socket.on("GAME_ACTION", ({ roomId, userId, actionType, data }) => {
    const state = rooms[roomId];
    if (!state) return;

    if (actionType === "HOST_FORCE_NEXT") {
      if (userId !== state.hostId) return;

      switch (state.phase) {
        case "NIGHT_GUARD":
        case "NIGHT_WOLF":
        case "NIGHT_WITCH":
        case "NIGHT_SEER":
          advanceNightStep(state, state.phase);
          break;
        case "DAY_SHERIFF_RUN":
          if (state.sheriffCandidates.length === 0) {
            announceDeathAndStartDay(state);
          } else {
            electSheriff(state, state.sheriffCandidates[0], "房主推進自動當選");
          }
          break;
        case "DAY_SHERIFF_SPEAK":
        case "DAY_DISCUSS":
        case "DAY_PK_SPEAK":
          state.speakerIdx++;
          if (state.speakerIdx >= state.speakingQueue.length) {
            if (state.phase === "DAY_SHERIFF_SPEAK") {
              state.phase = "DAY_SHERIFF_VOTE";
              state.votes = {};
              emitTTS(state.roomId, "請大家開始投票。");
            } else if (state.phase === "DAY_DISCUSS") {
              startDayVote(state);
            } else if (state.phase === "DAY_PK_SPEAK") {
              state.phase = "DAY_PK_VOTE";
              state.votes = {};
              emitTTS(state.roomId, "請大家開始投票。");
            }
          } else {
            state.speakerStartTime = Date.now();
            emitTTS(state.roomId, `請 ${state.speakingQueue[state.speakerIdx]} 號玩家開始發言。`);
          }
          break;
        case "DAY_NIGHT_LAST_WORDS":
          processFirstNightLastWords(state);
          break;
        case "DAY_ORDER_CHOOSE":
          setupDiscussQueue(state, state.players.find(p => !p.isSpectator && p.alive).seat, true);
          break;
        case "DAY_SHERIFF_CALL":
          startDayVote(state);
          break;
        case "DAY_SHERIFF_VOTE":
        case "DAY_VOTE":
        case "DAY_PK_VOTE":
          tallyVotes(state);
          break;
        case "DEATH_SKILL_CHECK":
          state.activeDeathSeat = null;
          processNextDeathQueue(state);
          break;
        case "DAY_LAST_WORDS":
          state.hunterDeathReason[state.exiledPlayer.seat] = "vote";
          state.pendingDeathQueue = [state.exiledPlayer.seat];
          state.postDeathHandler = "START_NIGHT";
          processNextDeathQueue(state);
          break;
        case "SHERIFF_TRANSFER":
          state.sheriff = null;
          processPostDeathStep(state);
          break;
      }
      broadcastRoomState(roomId);
      return;
    }

    if (actionType === "RESTART_GAME") {
      if (userId !== state.hostId) return;
      clearNightTimer(roomId);
      state.started = false;
      state.gameOver = false;
      state.winner = null;
      state.dayCount = 0;
      state.phase = "LOBBY";
      state.sheriff = null;
      state.sheriffRound = 1;
      state.sheriffDecisions = {};
      state.sheriffCandidates = [];
      state.sheriffWithdrawn = [];
      state.sheriffTieCandidates = [];
      state.sheriffLastSpeakQueue = [];
      state.sheriffCallTarget = null;
      state.dayPkRound = 1;
      state.dayPkCandidates = [];
      state.dayDiscussClockwise = true;
      state.pendingDeathSeats = [];
      state.pendingDeathQueue = [];
      state.firstNightLastWordsQueue = [];
      state.currentLastWordSeat = null;
      state.postDeathHandler = null;
      state.activeDeathSeat = null;
      state.hunterDeathReason = {};
      state.wolfTargets = {};
      state.wolfChatHistory = [];
      state.spectatorLogs = ["=== 房主已重置遊戲，請重新設定板子並開局 ==="];
      state.guardTarget = null;
      state.lastGuardTarget = null;
      state.witchAntidoteUsed = false;
      state.witchPoisonUsed = false;
      state.witchSaveThisNight = false;
      state.witchPoisonThisNight = null;
      state.seerCheckLog = null;
      state.lastKilled = null;
      state.speakingQueue = [];
      state.speakerIdx = 0;
      state.speakerStartTime = null;
      state.votes = {};
      state.exiledPlayer = null;
      state.logs = ["=== 房主已重置遊戲，請重新設定板子並發牌開局 ==="];

      state.players.forEach(p => {
        p.role = null;
        p.alive = true;
        p.explodedThisDay = false;
        p.isSheriff = false;
        p.idiotRevealed = false;
      });
      broadcastRoomState(roomId);
      return;
    }

    if (actionType === "START_GAME") {
      const { roles, winRule, enableSheriff, witchSelfSaveFirstNight } = data;
      state.winRule = winRule || "side";
      state.enableSheriff = enableSheriff;
      state.witchSelfSaveFirstNight = witchSelfSaveFirstNight !== undefined ? witchSelfSaveFirstNight : true;

      const gamePlayers = state.players.filter(p => !p.isSpectator);
      if (gamePlayers.length < roles.length) return;

      const shuffledRoles = [...roles].sort(() => Math.random() - 0.5);
      gamePlayers.forEach((p, idx) => {
        p.role = shuffledRoles[idx];
        p.alive = true;
        p.explodedThisDay = false;
        p.isSheriff = false;
        p.idiotRevealed = false;
      });

      state.started = true;
      state.gameOver = false;
      state.dayCount = 0;
      state.wolfChatHistory = [];
      state.spectatorLogs = [];
      state.witchAntidoteUsed = false;
      state.witchPoisonUsed = false;
      state.guardTarget = null;
      state.lastGuardTarget = null;
      logRoom(state, `=== 遊戲開始（${roles.length}人局・${winRule === 'all' ? '屠城規則' : '屠邊規則'}・女巫首夜${state.witchSelfSaveFirstNight ? '可自救' : '不可自救'}），天黑請閉眼 ===`);
      startNight(state);
    } else if (actionType === "GUARD_ACTION") {
      state.guardTarget = data.targetSeat;
      state.lastGuardTarget = data.targetSeat;
      logSpectator(state, `守衛行動：守護了【${data.targetSeat === 0 ? "空守" : data.targetSeat + " 號"}】。`);
      logRoom(state, "守衛完成守護。");
      advanceNightStep(state, "NIGHT_GUARD");
    } else if (actionType === "WOLF_VOTE") {
      const voter = state.players.find(p => p.id === userId);
      if (!voter || !voter.alive || !["狼人", "白狼王"].includes(voter.role)) return;

      state.wolfTargets[userId] = data.targetSeat;

      // 🌟 嚴格只過濾出「真正活著的狼人」名單與票數
      const trulyAliveWolves = state.players.filter(p => !p.isSpectator && ["狼人", "白狼王"].includes(p.role) && p.alive);
      const aliveVotes = trulyAliveWolves
        .map(w => state.wolfTargets[w.id])
        .filter(v => v !== undefined);

      // 當所有活狼人都已投票
      if (aliveVotes.length === trulyAliveWolves.length && trulyAliveWolves.length > 0) {
        const allSame = aliveVotes.every(v => v === aliveVotes[0]);
        if (allSame) {
          state.lastKilled = aliveVotes[0];
          if (aliveVotes[0] === 0) {
            logSpectator(state, `狼人行動：統一選擇【空刀（不擊殺任何人）】。`);
            logRoom(state, "狼人統一襲擊目標（選擇空刀）。");
          } else {
            logSpectator(state, `狼人行動：統一襲擊目標為【${aliveVotes[0]} 號】。`);
            logRoom(state, "狼人統一襲擊目標。");
          }
          advanceNightStep(state, "NIGHT_WOLF");
        }
      }
    } else if (actionType === "WITCH_ACTION") {
      if (data.save && state.lastKilled && state.lastKilled > 0) {
        state.witchSaveThisNight = true;
        state.witchAntidoteUsed = true;
        logSpectator(state, `女巫行動：使用解藥救起 ${state.lastKilled} 號。`);
      } else if (data.killSeat) {
        state.witchPoisonThisNight = data.killSeat;
        state.witchPoisonUsed = true;
        logSpectator(state, `女巫行動：使用毒藥毒殺 ${data.killSeat} 號。`);
      } else {
        logSpectator(state, "女巫行動：未使用藥劑。");
      }
      logRoom(state, "女巫完成行動。");
      advanceNightStep(state, "NIGHT_WITCH");
    } else if (actionType === "SEER_CHECK") {
      const target = state.players.find(p => !p.isSpectator && p.seat === data.targetSeat);
      const isBad = target && ["狼人", "白狼王"].includes(target.role);
      const resultString = isBad ? "狼人" : "好人";

      state.seerCheckLog = `查驗 ${data.targetSeat}號，身份為【${resultString}】`;
      logSpectator(state, `預言家行動：查驗 ${data.targetSeat} 號，結果為【${resultString}】。`);
      logRoom(state, "預言家完成驗人。");

      socket.emit("SEER_RESULT", {
        dayCount: state.dayCount,
        targetSeat: data.targetSeat,
        result: resultString
      });

      advanceNightStep(state, "NIGHT_SEER");
    } else if (actionType === "OPT_SHERIFF") {
      const player = state.players.find(p => p.id === userId);
      if (!player || player.isSpectator) return;

      state.sheriffDecisions[userId] = !!data.run;

      if (data.run) {
        if (!state.sheriffCandidates.includes(player.seat)) state.sheriffCandidates.push(player.seat);
      } else {
        state.sheriffCandidates = state.sheriffCandidates.filter(s => s !== player.seat);
      }

      const gamePlayers = state.players.filter(p => !p.isSpectator);
      const allChosen = gamePlayers.every(p => state.sheriffDecisions[p.id] !== undefined);

      if (allChosen) {
        if (state.sheriffCandidates.length === gamePlayers.length) {
          logRoom(state, "【警長競選】全員均選擇上警，無警下投票玩家！警徽流失，本局無警長。");
          emitTTS(state.roomId, "全員上警，警徽流失，本局無警長。");
          announceDeathAndStartDay(state);
        } else if (state.sheriffCandidates.length === 0) {
          logRoom(state, "【警長競選】無人競選警長，警徽流失，本局無警長。");
          emitTTS(state.roomId, "無人競選警長，本局無警長。");
          announceDeathAndStartDay(state);
        } else if (state.sheriffCandidates.length === 1) {
          electSheriff(state, state.sheriffCandidates[0], "僅一位候選人，自動當選警長！");
        } else {
          state.phase = "DAY_SHERIFF_SPEAK";
          state.sheriffRound = 1;
          const startIdx = Math.floor(Math.random() * state.sheriffCandidates.length);
          const queue = [];
          for (let i = 0; i < state.sheriffCandidates.length; i++) {
            queue.push(state.sheriffCandidates[(startIdx + i) % state.sheriffCandidates.length]);
          }
          state.speakingQueue = queue;
          state.sheriffLastSpeakQueue = [...queue];
          state.speakerIdx = 0;
          state.speakerStartTime = Date.now();
          logRoom(state, `上警名單：${state.sheriffCandidates.join(", ")} 號。從 ${queue[0]} 號開始順序發言。`);
          emitTTS(state.roomId, `請 ${queue[0]} 號玩家開始發言。`);
        }
      }
    } else if (actionType === "SHERIFF_WITHDRAW") {
      const player = state.players.find(p => p.id === userId);
      if (player && state.sheriffCandidates.includes(player.seat)) {
        state.sheriffCandidates = state.sheriffCandidates.filter(s => s !== player.seat);
        if (!state.sheriffWithdrawn.includes(player.seat)) state.sheriffWithdrawn.push(player.seat);
        logRoom(state, `【警長競選】${player.seat} 號選擇退水。`);

        const removeIdx = state.speakingQueue.indexOf(player.seat);
        if (removeIdx !== -1) {
          state.speakingQueue.splice(removeIdx, 1);
          if (state.speakerIdx > removeIdx) {
            state.speakerIdx--;
          }
        }

        if (state.sheriffCandidates.length === 1) {
          electSheriff(state, state.sheriffCandidates[0], "警上其餘人均已退水，自動當選警長！");
          broadcastRoomState(roomId);
          return;
        } else if (state.sheriffCandidates.length === 0) {
          logRoom(state, "警上候選人均已退水，警徽流失，本局無警長！");
          emitTTS(state.roomId, "警上候選人均已退水，警徽流失，本局無警長。");
          announceDeathAndStartDay(state);
          broadcastRoomState(roomId);
          return;
        }

        if (state.speakerIdx >= state.speakingQueue.length) {
          state.phase = "DAY_SHERIFF_VOTE";
          state.votes = {};
          logRoom(state, "警上發言結束，警下玩家開始投票。");
          emitTTS(state.roomId, "請大家開始投票。");
        } else {
          state.speakerStartTime = Date.now();
          emitTTS(state.roomId, `請 ${state.speakingQueue[state.speakerIdx]} 號玩家開始發言。`);
        }
      }
    } else if (actionType === "WOLF_EXPLODE") {
      const wolf = state.players.find(p => p.id === userId);
      if (wolf && ["狼人", "白狼王"].includes(wolf.role) && wolf.alive) {
        wolf.alive = false;
        wolf.explodedThisDay = true;
        logRoom(state, `${wolf.seat} 號狼人選擇自爆！自爆出局，直接進入黑夜。`);
        emitTTS(state.roomId, `${wolf.seat} 號狼人自爆出局！直接進入黑夜。`);

        if (checkGameOver(state)) {
          broadcastRoomState(roomId);
          return;
        }

        if (wolf.isSheriff) {
          state.postDeathHandler = "START_NIGHT";
          state.phase = "SHERIFF_TRANSFER";
          logRoom(state, `${wolf.seat} 號警長自爆出局，請移交或撕毀警徽。`);
          emitTTS(state.roomId, "警長自爆出局，請移交或撕毀警徽。");
        } else {
          startNight(state);
        }
      }
    } else if (actionType === "NEXT_SPEAKER") {
      const currentSpeakerSeat = state.speakingQueue[state.speakerIdx];
      const speakerPlayer = state.players.find(p => p.id === userId);
      if (!speakerPlayer || speakerPlayer.seat !== currentSpeakerSeat) return;

      state.speakerIdx++;
      if (state.speakerIdx >= state.speakingQueue.length) {
        state.speakerStartTime = null;
        if (state.phase === "DAY_SHERIFF_SPEAK") {
          state.phase = "DAY_SHERIFF_VOTE";
          state.votes = {};
          if (state.sheriffRound === 1) logRoom(state, "第一輪警上發言結束，警下玩家開始投票。");
          else if (state.sheriffRound === 2) logRoom(state, "首次平票 PK 反向發言結束，具投票權玩家開始投票。");
          else logRoom(state, "大眾發言結束，具投票權玩家開始投票。");
          emitTTS(state.roomId, "請大家開始投票。");
        } else if (state.phase === "DAY_DISCUSS") {
          const aliveSheriff = state.players.find(p => !p.isSpectator && p.isSheriff && p.alive);
          if (aliveSheriff) {
            state.phase = "DAY_SHERIFF_CALL";
            logRoom(state, `白天發言結束，請警長 ${aliveSheriff.seat} 號進行歸票。`);
            emitTTS(state.roomId, "發言結束，請警長歸票。");
          } else {
            startDayVote(state);
          }
        } else if (state.phase === "DAY_PK_SPEAK") {
          state.phase = "DAY_PK_VOTE";
          state.votes = {};
          logRoom(state, "公投 PK 反向發言結束，其餘存活玩家開始投票。");
          emitTTS(state.roomId, "請大家開始投票。");
        }
      } else {
        state.speakerStartTime = Date.now();
        emitTTS(state.roomId, `請 ${state.speakingQueue[state.speakerIdx]} 號玩家開始發言。`);
      }
    } else if (actionType === "FINISH_LAST_WORDS") {
      const caller = state.players.find(p => p.id === userId);
      if (!caller) return;

      if (state.phase === "DAY_NIGHT_LAST_WORDS") {
        if (caller.seat !== state.currentLastWordSeat) return;
        processFirstNightLastWords(state);
      } else if (state.phase === "DAY_LAST_WORDS") {
        if (caller.seat !== state.exiledPlayer.seat) return;
        logRoom(state, "放逐遺言結束。");
        state.hunterDeathReason[state.exiledPlayer.seat] = "vote";
        state.pendingDeathQueue = [state.exiledPlayer.seat];
        state.postDeathHandler = "START_NIGHT";
        processNextDeathQueue(state);
      }
    } else if (actionType === "SHERIFF_CALL") {
      state.sheriffCallTarget = data.targetSeat;
      logRoom(state, `警長歸票目標：【${data.targetSeat === 0 ? "不指定 / 隨意" : data.targetSeat + " 號"}】`);
      startDayVote(state);
    } else if (actionType === "CAST_VOTE") {
      const voter = state.players.find(p => p.id === userId);
      if (voter && voter.alive && !voter.isSpectator && !voter.idiotRevealed) {
        state.votes[voter.seat] = data.targetSeat;

        let eligibleCount = 0;
        if (state.phase === "DAY_SHERIFF_VOTE") {
          const eligibleVoters = state.players.filter(p => !p.isSpectator && p.alive && !p.idiotRevealed && !state.sheriffCandidates.includes(p.seat) && (state.sheriffRound >= 2 ? true : !state.sheriffWithdrawn.includes(p.seat)));
          eligibleCount = eligibleVoters.length;
        } else if (state.phase === "DAY_PK_VOTE") {
          const eligibleVoters = state.players.filter(p => !p.isSpectator && p.alive && !p.idiotRevealed && !state.dayPkCandidates.includes(p.seat));
          eligibleCount = eligibleVoters.length;
        } else {
          eligibleCount = state.players.filter(p => !p.isSpectator && p.alive && !p.idiotRevealed).length;
        }

        if (Object.keys(state.votes).length >= eligibleCount) {
          tallyVotes(state);
        }
      }
    } else if (actionType === "RESOLVE_DEATH_SKILL") {
      const { targetSeat } = data;
      const deadSeat = state.activeDeathSeat;
      const deadPlayer = state.players.find(p => !p.isSpectator && p.seat === deadSeat);

      if (deadPlayer && ["獵人", "白狼王"].includes(deadPlayer.role) && state.hunterDeathReason[deadSeat] !== "witch") {
        if (targetSeat > 0) {
          const shotTarget = state.players.find(p => !p.isSpectator && p.seat === targetSeat && p.alive);
          if (shotTarget) {
            shotTarget.alive = false;

            const hasWolfKing = state.players.some(p => p.role === "白狼王");
            if (hasWolfKing) {
              logRoom(state, `【出局開槍】${deadSeat} 號開槍帶走了 ${shotTarget.seat} 號玩家 (${shotTarget.name}) 出局！`);
              emitTTS(state.roomId, `${deadSeat} 號開槍帶走了 ${shotTarget.seat} 號玩家出局！`);
            } else {
              logRoom(state, `【出局玩家翻牌】${deadSeat} 號是【獵人】！發動技能翻槍帶走了 ${shotTarget.seat} 號玩家 (${shotTarget.name}) 出局！`);
              emitTTS(state.roomId, `${deadSeat} 號是獵人，翻槍帶走了 ${shotTarget.seat} 號玩家出局！`);
            }

            if (checkGameOver(state)) {
              broadcastRoomState(roomId);
              return;
            }

            state.hunterDeathReason[shotTarget.seat] = "shot";
            state.pendingDeathQueue.push(shotTarget.seat);

            if (shotTarget.isSheriff) {
              state.phase = "SHERIFF_TRANSFER";
              logRoom(state, `${shotTarget.seat} 號警長中槍出局，請移交或撕毀警徽。`);
              emitTTS(state.roomId, "警長中槍出局，請移交或撕毀警徽。");
              broadcastRoomState(roomId);
              return;
            }
          }
        }
      }

      state.activeDeathSeat = null;
      processNextDeathQueue(state);
    } else if (actionType === "SHERIFF_PASS") {
      const deadSheriff = state.players.find(p => p.isSheriff);
      if (deadSheriff) deadSheriff.isSheriff = false;

      if (data.targetSeat > 0) {
        const newSheriff = state.players.find(p => !p.isSpectator && p.seat === data.targetSeat && p.alive && !p.idiotRevealed);
        if (newSheriff) {
          newSheriff.isSheriff = true;
          state.sheriff = newSheriff.seat;
          logRoom(state, `警徽移交給 ${newSheriff.seat} 號！`);
          emitTTS(state.roomId, `警長將警徽移交至 ${newSheriff.seat} 號。`);
        }
      } else {
        state.sheriff = null;
        logRoom(state, "警長選擇撕掉警徽，本局再無警長！");
        emitTTS(state.roomId, "警長選擇撕毀警徽，本局再無警長。");
      }

      processPostDeathStep(state);
    } else if (actionType === "CHOOSE_ORDER") {
      const { startSeat, clockwise } = data;
      state.dayDiscussClockwise = clockwise;
      setupDiscussQueue(state, startSeat, clockwise);
    }

    broadcastRoomState(roomId);
  });

  socket.on("disconnect", () => {
    for (const roomId in rooms) {
      const state = rooms[roomId];
      const player = state.players.find(p => p.socketId === socket.id);
      if (player) {
        player.online = false;
        player.lastDisconnectAt = Date.now();
        broadcastRoomState(roomId);
        break;
      }
    }
  });
});

setInterval(() => {
  const now = Date.now();
  const EXPIRE_TIME = 2 * 60 * 60 * 1000;
  const ALL_OFFLINE_EXPIRE_TIME = 10 * 60 * 1000;

  for (const roomId in rooms) {
    const state = rooms[roomId];
    if (state.players.length === 0 || now - state.lastActiveTime > EXPIRE_TIME) {
      clearNightTimer(roomId);
      delete rooms[roomId];
      continue;
    }
    if (state.started) {
      const hasOnlinePlayer = state.players.some(p => p.online);
      if (!hasOnlinePlayer) {
        const earliestDisconnect = Math.min(...state.players.map(p => p.lastDisconnectAt || now));
        if (now - earliestDisconnect > ALL_OFFLINE_EXPIRE_TIME) {
          clearNightTimer(roomId);
          delete rooms[roomId];
        }
      }
    }
  }
}, 10 * 60 * 1000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`狼人殺 Server 已在 Port ${PORT} 啟動！`);
});