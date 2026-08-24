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

function getDefaultRoomState(roomId) {
  return {
    roomId,
    hostId: null,
    started: false,
    gameOver: false,
    winner: null,
    preset: "standard12_idiot",
    dayCount: 0,
    phase: "LOBBY",
    enableSheriff: true,
    sheriff: null,

    sheriffRound: 1,
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
    postDeathHandler: null,
    activeDeathSeat: null,
    hunterDeathReason: {},

    players: [], // { id, socketId, name, seat, role, alive, isSheriff, idiotRevealed, isSpectator, online, lastDisconnectAt }
    wolfTargets: {},

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
    votes: {},
    exiledPlayer: null,
    logs: [],
    lastActiveTime: Date.now()
  };
}

// 防作弊資料遮蔽 (Sanitization)
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

function logRoom(state, msg) {
  state.logs.push(msg);
}

// 重新整理並緊湊排序座位號 (僅在未開局時執行)
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
    logRoom(state, "🎉 所有狼人均已出局，【好人陣營獲勝】！遊戲結束。");
    return true;
  }

  if (state.preset === "standard6") {
    if (aliveGods.length === 0 && aliveVillagers.length === 0) {
      state.gameOver = true;
      state.winner = "狼人陣營";
      logRoom(state, "🐺 好人陣營全數出局（屠城），【狼人陣營獲勝】！遊戲結束。");
      return true;
    }
  } else {
    if (aliveGods.length === 0) {
      state.gameOver = true;
      state.winner = "狼人陣營";
      logRoom(state, "🐺 神職陣營全數出局（屠邊成功），【狼人陣營獲勝】！遊戲結束。");
      return true;
    }
    if (aliveVillagers.length === 0) {
      state.gameOver = true;
      state.winner = "狼人陣營";
      logRoom(state, "🐺 平民陣營全數出局（屠邊成功），【狼人陣營獲勝】！遊戲結束。");
      return true;
    }
  }
  return false;
}

function enterNightPhase(state, phaseName) {
  state.phase = phaseName;

  if (phaseName === "NIGHT_GUARD") {
    const guard = state.players.find(p => !p.isSpectator && p.role === "守衛" && p.alive);
    if (!guard) {
      setTimeout(() => {
        logRoom(state, "守衛行動結束。");
        enterNightPhase(state, "NIGHT_WOLF");
        broadcastRoomState(state.roomId);
      }, 2000);
    }
  } else if (phaseName === "NIGHT_WOLF") {
    state.wolfTargets = {};
    const aliveWolves = state.players.filter(p => !p.isSpectator && ["狼人", "白狼王"].includes(p.role) && p.alive);
    if (aliveWolves.length === 0) {
      setTimeout(() => {
        logRoom(state, "狼人行動結束。");
        enterNightPhase(state, "NIGHT_WITCH");
        broadcastRoomState(state.roomId);
      }, 2000);
    }
  } else if (phaseName === "NIGHT_WITCH") {
    const witch = state.players.find(p => !p.isSpectator && p.role === "女巫" && p.alive);
    if (!witch) {
      setTimeout(() => {
        logRoom(state, "女巫行動結束。");
        enterNightPhase(state, "NIGHT_SEER");
        broadcastRoomState(state.roomId);
      }, 2000);
    }
  } else if (phaseName === "NIGHT_SEER") {
    const seer = state.players.find(p => !p.isSpectator && p.role === "預言家" && p.alive);
    if (!seer) {
      setTimeout(() => {
        logRoom(state, "預言家行動結束。");
        finishNight(state);
        broadcastRoomState(state.roomId);
      }, 2000);
    }
  }
}

function startNight(state) {
  if (checkGameOver(state)) return;
  state.dayCount++;
  state.guardTarget = null;
  state.witchSaveThisNight = false;
  state.witchPoisonThisNight = null;
  state.lastKilled = null;
  state.seerCheckLog = null;
  state.sheriffCallTarget = null;
  state.dayPkRound = 1;
  state.dayPkCandidates = [];

  if (state.preset === "standard12_wolfking") {
    enterNightPhase(state, "NIGHT_GUARD");
  } else {
    enterNightPhase(state, "NIGHT_WOLF");
  }
}

function finishNight(state) {
  let deadSeats = [];
  state.hunterDeathReason = {};

  const wolfTarget = state.lastKilled;
  const isGuarded = state.guardTarget && state.guardTarget === wolfTarget;
  const isSaved = state.witchSaveThisNight;

  if (wolfTarget) {
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

  state.pendingDeathSeats = deadSeats;

  if (state.enableSheriff && !state.sheriff && state.dayCount === 1) {
    state.phase = "DAY_SHERIFF_RUN";
    state.sheriffCandidates = [];
    state.sheriffWithdrawn = [];
    logRoom(state, `=== 第 ${state.dayCount} 天天亮。先進行警長競選（死訊尚未公佈） ===`);
  } else {
    announceDeathAndStartDay(state);
  }
}

function announceDeathAndStartDay(state) {
  state.pendingDeathSeats.forEach(seat => {
    const p = state.players.find(pl => !pl.isSpectator && pl.seat === seat);
    if (p) p.alive = false;
  });

  logRoom(state, `=== 第 ${state.dayCount} 天死訊公佈：昨晚出局：${state.pendingDeathSeats.length > 0 ? state.pendingDeathSeats.join(", ") + " 號" : "平安夜"} ===`);

  if (checkGameOver(state)) return;

  state.postDeathHandler = "START_DAY_PROCESS";
  state.pendingDeathQueue = [...state.pendingDeathSeats];

  if (state.pendingDeathQueue.length > 0) {
    processNextDeathQueue(state);
  } else {
    processPostDeathStep(state);
  }
}

function processNextDeathQueue(state) {
  if (state.pendingDeathQueue.length > 0) {
    const nextDead = state.pendingDeathQueue.shift();
    state.activeDeathSeat = nextDead;
    state.phase = "DEATH_SKILL_CHECK";
  } else {
    processPostDeathStep(state);
  }
}

function processPostDeathStep(state) {
  const deadSheriff = state.players.find(p => p.isSheriff && !p.alive);
  if (deadSheriff) {
    state.phase = "SHERIFF_TRANSFER";
    logRoom(state, `警長 ${deadSheriff.seat} 號出局，請移交或撕毀警徽。`);
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
  logRoom(state, `🎉 ${seat} 號當選警長！(${reason})`);

  if (state.dayCount === 1 && state.pendingDeathSeats.length > 0 && state.players.filter(pl => !pl.isSpectator && !pl.alive).length === 0) {
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
  state.phase = "DAY_DISCUSS";
  logRoom(state, `發言順序已確立：從 ${startSeat} 號開始（${clockwise ? "順時針" : "逆時針"}）：${queue.join(" ➔ ")} 號。`);
}

function startDayVote(state) {
  state.phase = "DAY_VOTE";
  state.votes = {};
  logRoom(state, "進入白天放逐公投，請存活且未翻牌玩家投票。");
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
      voteDetails.push(`${voterSeat}號${voter && voter.isSheriff ? '(警長)' : ''} ➔ ${targetSeat}號 (${weight}票)`);
    } else {
      voteDetails.push(`${voterSeat}號 ➔ 棄票`);
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
        logRoom(state, `警長首次平票（${tieSeats.join(", ")} 號）！平票者依反方向再次發言：${reversedTieQueue.join(" ➔ ")} 號。其餘未平票上警者淘汰獲得投票權。`);
      } else if (state.sheriffRound === 2 && isTie) {
        state.sheriffRound = 3;
        state.sheriffTieCandidates = tieSeats;
        state.phase = "DAY_SHERIFF_SPEAK";

        const otherSpeakers = state.players.filter(p => !p.isSpectator && p.alive && !tieSeats.includes(p.seat)).map(p => p.seat);
        state.speakingQueue = otherSpeakers;
        state.speakerIdx = 0;
        logRoom(state, `警長再次平票（${tieSeats.join(", ")} 號）！進入大眾發言輪，由警下、退水及淘汰玩家依次發言並投票。平票候選人仍可退水。`);
      } else {
        logRoom(state, "警長再度平票（或全體棄票），警徽流失，本局無警長！");
        announceDeathAndStartDay(state);
      }
    }
  } else {
    if (maxSeat && !isTie) {
      const exiled = state.players.find(p => !p.isSpectator && p.seat === maxSeat);

      if (exiled.role === "白痴" && !exiled.idiotRevealed) {
        exiled.idiotRevealed = true;
        logRoom(state, `🃏【白痴翻牌免死】${maxSeat} 號是【白痴】！翻牌免除本次放逐，繼續存活在場，但喪失公投投票權！`);

        if (exiled.isSheriff) {
          state.postDeathHandler = "START_NIGHT";
          state.phase = "SHERIFF_TRANSFER";
          logRoom(state, `白痴警長被投票放逐，雖免死但必須移交或撕毀警徽！`);
        } else {
          startNight(state);
        }
        return;
      }

      exiled.alive = false;
      state.exiledPlayer = exiled;
      state.phase = "DAY_LAST_WORDS";
      logRoom(state, `💀 ${maxSeat} 號以 ${maxCount} 票被放逐出局，請發表遺言。`);
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
        logRoom(state, `⚖️ 公投首次平票（${tieSeats.join(", ")} 號）！進入 PK 環節，依反方向發言：${pkQueue.join(" ➔ ")} 號。`);
      } else {
        logRoom(state, "公投再次平票（或無有效票），本日無人出局，直接進入黑夜。");
        startNight(state);
      }
    }
  }
}

io.on("connection", (socket) => {
  // 加入房間 / 斷線重連
  socket.on("JOIN_ROOM", ({ roomId, userId, name, isSpectator }) => {
    if (!rooms[roomId]) {
      rooms[roomId] = getDefaultRoomState(roomId);
    }
    const state = rooms[roomId];

    let player = state.players.find(p => p.id === userId);
    if (!player) {
      if (!state.started) {
        const gamePlayers = state.players.filter(p => !p.isSpectator);
        player = {
          id: userId,
          socketId: socket.id,
          name: name || `玩家${userId.slice(-4)}`,
          seat: isSpectator ? null : gamePlayers.length + 1,
          role: null,
          alive: true,
          isSheriff: false,
          idiotRevealed: false,
          isSpectator: !!isSpectator,
          online: true,
          lastDisconnectAt: null
        };
        state.players.push(player);
        if (!state.hostId) state.hostId = userId;
        logRoom(state, `${player.name} 加入了房間 ${player.isSpectator ? '（觀眾席）' : `（${player.seat}號位）`}`);
      } else {
        socket.emit("JOIN_ERROR", "遊戲已在進行中，無法以新玩家身分加入。");
        return;
      }
    } else {
      // 玩家斷線重連，更新 Socket ID 與在線狀態
      player.socketId = socket.id;
      player.online = true;
      player.lastDisconnectAt = null;
      if (name && !state.started) player.name = name;
      logRoom(state, `${player.name}（${player.seat ? player.seat + '號' : '觀眾'}）已重新連線。`);
    }

    socket.join(roomId);
    broadcastRoomState(roomId);
  });

  // 主動退出房間
  socket.on("LEAVE_ROOM", ({ roomId, userId }) => {
    const state = rooms[roomId];
    if (!state) return;

    const playerIndex = state.players.findIndex(p => p.id === userId);
    if (playerIndex === -1) return;
    const player = state.players[playerIndex];

    if (!state.started) {
      // 未開局：直接從清單中移除並重新整理座位號
      state.players.splice(playerIndex, 1);
      reorderSeats(state);
      logRoom(state, `${player.name} 離開了房間。`);

      // 若房主離開，移交給下一位在場玩家
      if (state.hostId === userId) {
        state.hostId = state.players.length > 0 ? state.players[0].id : null;
      }

      socket.leave(roomId);

      // 若房間無人，立即銷毀
      if (state.players.length === 0) {
        delete rooms[roomId];
        return;
      }
    } else {
      // 開局中主動退出：標記離線
      player.online = false;
      player.lastDisconnectAt = Date.now();
      logRoom(state, `${player.name}（${player.seat}號）離線。`);
      socket.leave(roomId);
    }

    broadcastRoomState(roomId);
  });

  socket.on("GAME_ACTION", ({ roomId, userId, actionType, data }) => {
    const state = rooms[roomId];
    if (!state) return;

    if (actionType === "HOST_FORCE_NEXT") {
      if (userId !== state.hostId) return;

      switch (state.phase) {
        case "NIGHT_GUARD":
          enterNightPhase(state, "NIGHT_WOLF");
          break;
        case "NIGHT_WOLF":
          enterNightPhase(state, "NIGHT_WITCH");
          break;
        case "NIGHT_WITCH":
          enterNightPhase(state, "NIGHT_SEER");
          break;
        case "NIGHT_SEER":
          finishNight(state);
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
            } else if (state.phase === "DAY_DISCUSS") {
              startDayVote(state);
            } else if (state.phase === "DAY_PK_SPEAK") {
              state.phase = "DAY_PK_VOTE";
              state.votes = {};
            }
          }
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
      state.started = false;
      state.gameOver = false;
      state.winner = null;
      state.dayCount = 0;
      state.phase = "LOBBY";
      state.sheriff = null;
      state.sheriffRound = 1;
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
      state.postDeathHandler = null;
      state.activeDeathSeat = null;
      state.hunterDeathReason = {};
      state.wolfTargets = {};
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
      state.votes = {};
      state.exiledPlayer = null;
      state.logs = ["=== 房主已重置遊戲，請重新設定板子並發牌開局 ==="];

      state.players.forEach(p => {
        p.role = null;
        p.alive = true;
        p.isSheriff = false;
        p.idiotRevealed = false;
      });
      broadcastRoomState(roomId);
      return;
    }

    if (actionType === "START_GAME") {
      const { preset, enableSheriff } = data;
      state.preset = preset;
      state.enableSheriff = enableSheriff;
      let roles = [];

      if (preset === "standard6") {
        roles = ["狼人", "狼人", "預言家", "女巫", "村民", "村民"];
      } else if (preset === "standard9") {
        roles = ["狼人", "狼人", "狼人", "預言家", "女巫", "獵人", "村民", "村民", "村民"];
      } else if (preset === "standard12_idiot") {
        roles = ["狼人", "狼人", "狼人", "狼人", "預言家", "女巫", "獵人", "白痴", "村民", "村民", "村民", "村民"];
      } else if (preset === "standard12_wolfking") {
        roles = ["狼人", "狼人", "狼人", "白狼王", "預言家", "女巫", "獵人", "守衛", "村民", "村民", "村民", "村民"];
      }

      const gamePlayers = state.players.filter(p => !p.isSpectator);
      if (gamePlayers.length < roles.length) return;

      roles.sort(() => Math.random() - 0.5);
      gamePlayers.forEach((p, idx) => {
        p.role = roles[idx];
        p.alive = true;
        p.isSheriff = false;
        p.idiotRevealed = false;
      });

      state.started = true;
      state.gameOver = false;
      state.dayCount = 0;
      state.witchAntidoteUsed = false;
      state.witchPoisonUsed = false;
      state.guardTarget = null;
      state.lastGuardTarget = null;
      logRoom(state, "=== 遊戲開始，天黑請閉眼 ===");
      startNight(state);
    } else if (actionType === "GUARD_ACTION") {
      state.guardTarget = data.targetSeat;
      state.lastGuardTarget = data.targetSeat;
      logRoom(state, "守衛完成守護。");
      enterNightPhase(state, "NIGHT_WOLF");
    } else if (actionType === "WOLF_VOTE") {
      state.wolfTargets[userId] = data.targetSeat;
      const aliveWolves = state.players.filter(p => !p.isSpectator && ["狼人", "白狼王"].includes(p.role) && p.alive);
      const votes = Object.values(state.wolfTargets);

      if (votes.length >= aliveWolves.length) {
        const allSame = votes.every(v => v === votes[0]);
        if (allSame) {
          state.lastKilled = votes[0];
          logRoom(state, "狼人統一襲擊目標，輪到女巫行動。");
          enterNightPhase(state, "NIGHT_WITCH");
        }
      }
    } else if (actionType === "WITCH_ACTION") {
      if (data.save && state.lastKilled) {
        state.witchSaveThisNight = true;
        state.witchAntidoteUsed = true;
      }
      if (data.killSeat) {
        state.witchPoisonThisNight = data.killSeat;
        state.witchPoisonUsed = true;
      }
      logRoom(state, "女巫完成行動，輪到預言家。");
      enterNightPhase(state, "NIGHT_SEER");
    } else if (actionType === "SEER_CHECK") {
      const target = state.players.find(p => !p.isSpectator && p.seat === data.targetSeat);
      const isBad = target && ["狼人", "白狼王"].includes(target.role);
      const resultString = isBad ? "狼人" : "好人";

      state.seerCheckLog = `查驗 ${data.targetSeat}號，身份為【${resultString}】`;
      logRoom(state, "預言家完成驗人。");

      socket.emit("SEER_RESULT", {
        dayCount: state.dayCount,
        targetSeat: data.targetSeat,
        result: resultString
      });

      finishNight(state);
    } else if (actionType === "OPT_SHERIFF") {
      const player = state.players.find(p => p.id === userId);
      if (data.run) {
        if (!state.sheriffCandidates.includes(player.seat)) state.sheriffCandidates.push(player.seat);
      } else {
        state.sheriffCandidates = state.sheriffCandidates.filter(s => s !== player.seat);
      }
    } else if (actionType === "FINISH_SHERIFF_ENROLL") {
      if (state.sheriffCandidates.length === 0) {
        logRoom(state, "無人競選警長，本局無警長。");
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
        logRoom(state, `上警名單：${state.sheriffCandidates.join(", ")} 號。從 ${queue[0]} 號開始順序發言。`);
      }
    } else if (actionType === "SHERIFF_WITHDRAW") {
      const player = state.players.find(p => p.id === userId);
      if (player && state.sheriffCandidates.includes(player.seat)) {
        state.sheriffCandidates = state.sheriffCandidates.filter(s => s !== player.seat);
        if (!state.sheriffWithdrawn.includes(player.seat)) state.sheriffWithdrawn.push(player.seat);
        logRoom(state, `【警長競選】${player.seat} 號選擇退水。`);

        if (state.sheriffCandidates.length === 1) {
          electSheriff(state, state.sheriffCandidates[0], "警上其餘人均已退水，自動當選警長！");
          broadcastRoomState(roomId);
          return;
        }

        if (state.speakingQueue[state.speakerIdx] === player.seat) {
          state.speakerIdx++;
        }
      }
    } else if (actionType === "WOLF_EXPLODE") {
      const wolf = state.players.find(p => p.id === userId);
      if (wolf && ["狼人", "白狼王"].includes(wolf.role) && wolf.alive) {
        wolf.alive = false;
        logRoom(state, `💥💥💥 ${wolf.seat} 號狼人選擇自爆！自爆出局，直接進入黑夜。`);

        if (checkGameOver(state)) {
          broadcastRoomState(roomId);
          return;
        }

        if (wolf.isSheriff) {
          state.postDeathHandler = "START_NIGHT";
          state.phase = "SHERIFF_TRANSFER";
          logRoom(state, `${wolf.seat} 號警長自爆出局，請移交或撕毀警徽。`);
        } else {
          startNight(state);
        }
      }
    } else if (actionType === "NEXT_SPEAKER") {
      state.speakerIdx++;
      if (state.speakerIdx >= state.speakingQueue.length) {
        if (state.phase === "DAY_SHERIFF_SPEAK") {
          state.phase = "DAY_SHERIFF_VOTE";
          state.votes = {};
          if (state.sheriffRound === 1) logRoom(state, "第一輪警上發言結束，警下玩家開始投票。");
          else if (state.sheriffRound === 2) logRoom(state, "首次平票 PK 反向發言結束，具投票權玩家開始投票。");
          else logRoom(state, "大眾發言結束，具投票權玩家開始投票。");
        } else if (state.phase === "DAY_DISCUSS") {
          const aliveSheriff = state.players.find(p => !p.isSpectator && p.isSheriff && p.alive);
          if (aliveSheriff) {
            state.phase = "DAY_SHERIFF_CALL";
            logRoom(state, `白天發言結束，請警長 ${aliveSheriff.seat} 號進行歸票。`);
          } else {
            startDayVote(state);
          }
        } else if (state.phase === "DAY_PK_SPEAK") {
          state.phase = "DAY_PK_VOTE";
          state.votes = {};
          logRoom(state, "公投 PK 反向發言結束，其餘存活玩家開始投票。");
        }
      }
    } else if (actionType === "SHERIFF_CALL") {
      state.sheriffCallTarget = data.targetSeat;
      logRoom(state, `⭐ 警長歸票目標：【${data.targetSeat === 0 ? "不指定 / 隨意" : data.targetSeat + " 號"}】`);
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

            if (state.preset === "standard12_wolfking") {
              logRoom(state, `🔫【出局開槍】${deadSeat} 號開槍帶走了 ${shotTarget.seat} 號玩家 (${shotTarget.name})！`);
            } else {
              logRoom(state, `🔫【出局玩家翻牌】${deadSeat} 號是【獵人】！發動技能翻槍帶走了 ${shotTarget.seat} 號玩家 (${shotTarget.name})！`);
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
          logRoom(state, `⭐ 警徽移交給 ${newSheriff.seat} 號！`);
        }
      } else {
        state.sheriff = null;
        logRoom(state, "⭐ 警長選擇撕掉警徽，本局再無警長！");
      }

      processPostDeathStep(state);
    } else if (actionType === "FINISH_LAST_WORDS") {
      logRoom(state, "遺言結束。");
      state.hunterDeathReason[state.exiledPlayer.seat] = "vote";
      state.pendingDeathQueue = [state.exiledPlayer.seat];
      state.postDeathHandler = "START_NIGHT";
      processNextDeathQueue(state);
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

// 定時垃圾回收機制 (每 10 分鐘檢查一次)
setInterval(() => {
  const now = Date.now();
  const EXPIRE_TIME = 2 * 60 * 60 * 1000; // 閒置超過 2 小時銷毀
  const ALL_OFFLINE_EXPIRE_TIME = 10 * 60 * 1000; // 開局中全員離線超過 10 分鐘銷毀

  for (const roomId in rooms) {
    const state = rooms[roomId];

    // 1. 空房立即清理
    if (state.players.length === 0) {
      delete rooms[roomId];
      continue;
    }

    // 2. 超過 2 小時無操作清理
    if (now - state.lastActiveTime > EXPIRE_TIME) {
      delete rooms[roomId];
      continue;
    }

    // 3. 遊戲進行中若全員離線超過 10 分鐘清理
    if (state.started) {
      const hasOnlinePlayer = state.players.some(p => p.online);
      if (!hasOnlinePlayer) {
        const earliestDisconnect = Math.min(...state.players.map(p => p.lastDisconnectAt || now));
        if (now - earliestDisconnect > ALL_OFFLINE_EXPIRE_TIME) {
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