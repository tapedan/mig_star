  /**
   * Storage wrapper com camadas:
   * 1) tenta localStorage
   * 2) senão, usa IndexedDB (carrega tudo no cache para acesso síncrono)
   * 3) senão, tenta usar interface Android exposta (AndroidStorage, Android, AndroidBridge)
   * 4) senão, fallback em memória
   *
   * Usa: storage.getItem(key), storage.setItem(key,value), storage.removeItem(key), storage.clear()
   * e storage.ready (Promise que resolve quando inicializado)
   */
  (function() {
    const storage = {
      backend: 'none',
      _cache: {},
      _idb: null,
      ready: null,
      getItem(key){ return (this._cache.hasOwnProperty(key) ? this._cache[key] : null); },
      setItem(key, value){
        this._cache[key] = String(value);
        persistSet(key, String(value));
      },
      removeItem(key){
        delete this._cache[key];
        persistRemove(key);
      },
      clear(){
        this._cache = {};
        persistClear();
      }
    };

    // helpers de persistência que mudarão conforme backend
    let persistSet = (k,v)=>{};
    let persistRemove = (k)=>{};
    let persistClear = ()=>{};

    async function tryLocalStorage() {
      try {
        const testKey = '__mig_test__';
        window.localStorage.setItem(testKey, '1');
        window.localStorage.removeItem(testKey);
        // está ok -> carregar keys
        storage.backend = 'localStorage';
        for(let i=0;i<localStorage.length;i++){
          const k = localStorage.key(i);
          const v = localStorage.getItem(k);
          if (k) storage._cache[k] = v;
        }
        persistSet = (k,v)=>{ try { localStorage.setItem(k,v); } catch(e){ console.warn('localStorage.setItem falhou',e);} };
        persistRemove = (k)=>{ try { localStorage.removeItem(k); } catch(e){ } };
        persistClear = ()=>{ try { localStorage.clear(); } catch(e){} };
        return true;
      } catch(e){
        return false;
      }
    }

    function openIndexedDB(){
      return new Promise((res, rej) => {
        if (!('indexedDB' in window)) return rej('no-indexeddb');
        const req = indexedDB.open('migstar_db_v1', 1);
        req.onupgradeneeded = (e) => {
          const db = e.target.result;
          if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
        };
        req.onsuccess = (e) => res(e.target.result);
        req.onerror = (e) => rej(e.target.error || 'idb-error');
      });
    }

    async function tryIndexedDB() {
      try {
        const db = await openIndexedDB();
        storage._idb = db;
        storage.backend = 'indexedDB';
        // carregar todo o store para cache
        const tx = db.transaction('kv','readonly');
        const store = tx.objectStore('kv');
        const allReq = store.openCursor();
        return new Promise((res, rej) => {
          allReq.onsuccess = (e) => {
            const cursor = e.target.result;
            if (cursor) {
              storage._cache[cursor.key] = cursor.value;
              cursor.continue();
            } else {
              // definimos persist funcs que usam IDB
              persistSet = (k,v) => {
                try {
                  const wtx = db.transaction('kv','readwrite');
                  wtx.objectStore('kv').put(v,k);
                } catch(e){ console.warn('idb set falhou',e); }
              };
              persistRemove = (k) => {
                try {
                  const wtx = db.transaction('kv','readwrite');
                  wtx.objectStore('kv').delete(k);
                } catch(e){}
              };
              persistClear = () => {
                try {
                  const wtx = db.transaction('kv','readwrite');
                  wtx.objectStore('kv').clear();
                } catch(e){}
              };
              res(true);
            }
          };
          allReq.onerror = (e) => rej(e.target.error || 'cursor-error');
        });
      } catch(e){
        console.warn('indexedDB não disponível', e);
        return false;
      }
    }

    async function tryAndroidBridge() {
      // tenta vários nomes comuns que geradores de APK usam ao expor API nativa
      const candidates = ['AndroidStorage','Android','AndroidBridge','android'];
      for (const name of candidates) {
        if (window[name]) {
          try {
            // se existir um getItem síncrono, pega chaves úteis e popula cache (tentativa)
            const api = window[name];
            storage.backend = 'android:' + name;
            // definir persist funcs
            if (typeof api.setItem === 'function') {
              persistSet = (k,v)=>{ try{ api.setItem(k,v); } catch(e){ console.warn('android.setItem falhou',e);} };
            } else if (typeof api.set === 'function') {
              persistSet = (k,v)=>{ try{ api.set(k,v); } catch(e){} };
            } else {
              persistSet = ()=>{ console.warn('android bridge sem setItem'); };
            }
            if (typeof api.getItem === 'function') {
              persistRemove = (k)=>{ try{ if(api.removeItem) api.removeItem(k); } catch(e){} };
              // tenta carregar chaves que costumamos usar
              const keysToTry = ['migstar_user','migstar_missionPool','migstar_transactions','migstar_history','migstar_todayMissions'];
              keysToTry.forEach(k=>{
                try {
                  const v = api.getItem(k);
                  if (v !== null && v !== undefined) storage._cache[k] = v;
                } catch(e){}
              });
              return true;
            }
          } catch(e){ console.warn('android bridge test error', e); }
        }
      }
      return false;
    }

    // fallback memoria -> já definido por padrão (persist funcs vazios)
    async function init() {
      // 1) tenta localStorage
      if (await tryLocalStorage()) {
        return storage;
      }
      // 2) tenta indexedDB
      if (await tryIndexedDB()) {
        return storage;
      }
      // 3) tenta android bridge
      if (await tryAndroidBridge()) {
        return storage;
      }
      // 4) fallback (cache em memória). Podemos também usar cookies aqui como tentativa extra:
      try {
        // carregar cookies se existir
        const cookies = document.cookie ? document.cookie.split('; ').map(c => c.split('=')) : [];
        cookies.forEach(([k,v])=>{ try { storage._cache[decodeURIComponent(k)] = decodeURIComponent(v); } catch(e){} });
      } catch(e){}
      storage.backend = 'memory';
      console.warn('Usando storage fallback em memória. Persistência pode não funcionar no WebView atual.');
      return storage;
    }

    storage.ready = init().then(() => {
      window.__mig_storage = storage;
      // expose a shorthand global 'storage' (não sobrescreve se já existe)
      if (!window.storage) window.storage = storage;
      return storage;
    });

    // expõe no window para o app usar
    window.__mig_storage = storage;
    if (!window.storage) window.storage = storage;
  })();

  // ===========================
  // APLICATIVO MIGSTAR (usa window.storage)
  // ===========================
  (function() {
    // garantimos que DOM e storage estejam prontos
    async function boot() {
      await documentReady();
      await (window.storage && window.storage.ready ? window.storage.ready : Promise.resolve());

      // agora o DOM + storage estão prontos -> inicializa app
      initApp();
    }

    function documentReady() {
      return new Promise(res => {
        if (document.readyState === 'complete' || document.readyState === 'interactive') return res();
        document.addEventListener('DOMContentLoaded', () => res());
      });
    }

    // Copiando/adaptando o seu script original para usar window.storage
    function initApp(){
      const state = {
        user: null,
        missions: [],
        transactions: [],
        history: [],
        todayMissions: [],
        todayDate: new Date().toISOString().split('T')[0]
      };

      const elements = {
        userBalance: document.getElementById('userBalance'),
        userName: document.getElementById('userName'),
        starSymbol: document.getElementById('starSymbol'),
        missionsContainer: document.getElementById('missionsContainer'),
        historyContainer: document.getElementById('historyContainer'),
        missionProgress: document.getElementById('missionProgress'),
        completedMissionsCount: document.getElementById('completedMissionsCount'),
        lastTransaction: document.getElementById('lastTransaction'),
        lastMission: document.getElementById('lastMission'),
        toast: document.getElementById('toast'),
        passwordModal: document.getElementById('passwordModal'),
        passwordInput: document.getElementById('passwordInput'),
        passwordError: document.getElementById('passwordError'),
        confirmPassword: document.getElementById('confirmPassword'),
        cancelPassword: document.getElementById('cancelPassword'),
        receiveBtn: document.getElementById('receiveBtn'),
        sender: document.getElementById('sender'),
        amount: document.getElementById('amount'),
        resetBtn: document.getElementById('resetBtn'),
        showAll: document.getElementById('showAll'),
        showTransactions: document.getElementById('showTransactions'),
        showMissions: document.getElementById('showMissions'),
        tabContents: document.getElementById('tabContents'),
        tabButtons: document.querySelectorAll('.tab-btn')
      };

      // missão pool inalterado
      const missionPool = [
        { id: 1, title: "Arrumar a cama", reward: 10 },
        { id: 2, title: "Escovar os dentes", reward: 5 },
        { id: 3, title: "Ler 10 páginas de Um diário de um Banana", reward: 10 },
        { id: 4, title: "Fazer 2 gols no futebol", reward: 10 },
        { id: 5, title: "Ajudar a arrumar a mesa", reward: 5 },
        { id: 6, title: "Arrumar o quarto", reward: 5 },
        { id: 7, title: "Arrumar a caminha da Pipoca", reward: 5 },
        { id: 8, title: "Alimentar a Pipoca", reward: 5 },
        { id: 9, title: "Rezar um Pai Nosso", reward: 10 },
        { id: 10, title: "Arrumar a mochila da escola", reward: 5 },
        { id: 11, title: "Deixar os dentes bem limpinhos", reward: 5 },
        { id: 12, title: "Dizer para o pai e a mãe 'Te amo'", reward: 10 },
        { id: 13, title: "Jogar Mario Kart 8 Deluxe", reward: 5 },
        { id: 14, title: "Agradecer a Deus por tudo", reward: 10 },
        { id: 15, title: "Jogar Minecraft", reward: 3 },
        { id: 16, title: "Tirar 10 em uma prova ou lição", reward: 10 },
        { id: 17, title: "Não fazer sujeira no Jantar", reward: 5 },
        { id: 18, title: "Fazer uma boa ação", reward: 10 },
        { id: 19, title: "Ler as noticias do Nintendo Switch", reward: 5 },
        { id: 20, title: "Ficar vendo muito pouco celular", reward: 5 },
        { id: 21, title: "Ir para a escola", reward: 5 },
        { id: 22, title: "Jogar bola com o Gustavo", reward: 5 },
        { id: 23, title: "Fazer exercícios por 10 minutos", reward: 5 },
        { id: 24, title: "Estudar alguma coisa", reward: 5 },
        { id: 25, title: "Faça um desenho", reward: 5 },
        { id: 26, title: "Faça uma lição no Duolingo", reward: 5 },
        { id: 27, title: "Jogue uma partida de Trio com o Pai e o Danilo", reward: 50 },
        { id: 28, title: "Faça uma noite de jogos (APENAS SE FOR UM DIA QUE DÊ, CASO CONTRÁRIO MARQUE COMO FEITO()", reward: 10 },
        { id: 29, title: "Dirija no City Car Driving Simulator", reward: 10 },
        { id: 30, title: "Jogue Hellapagos", reward: 15 }
      ];

      // Funções de storage utilitárias (usam window.storage)
      const S = window.storage || window.__mig_storage;
      function sGet(k){ try { return S.getItem(k); } catch(e){ return null; } }
      function sSet(k,v){ try { S.setItem(k,v); } catch(e){ console.warn('storage set falhou',e); } }
      function sRemove(k){ try { S.removeItem(k); } catch(e){} }

      // Load state from storage
      function loadState() {
        const userRaw = sGet('migstar_user');
        state.user = userRaw ? JSON.parse(userRaw) : {
          name: "Miguel",
          stars: 50,
          lastAssignedDate: state.todayDate,
          completedMissionsToday: []
        };

        const missionPoolRaw = sGet('migstar_missionPool');
        state.missions = missionPoolRaw ? JSON.parse(missionPoolRaw) : missionPool;

        const txRaw = sGet('migstar_transactions');
        state.transactions = txRaw ? JSON.parse(txRaw) : [];

        const historyRaw = sGet('migstar_history');
        state.history = historyRaw ? JSON.parse(historyRaw) : [];

        const todayRaw = sGet('migstar_todayMissions');
        state.todayMissions = todayRaw ? JSON.parse(todayRaw) : [];
      }

      function checkNewDay() {
        if (state.user.lastAssignedDate !== state.todayDate) {
          assignDailyMissions();
          state.user.lastAssignedDate = state.todayDate;
          state.user.completedMissionsToday = [];
          saveUser();
        } else if (state.todayMissions.length === 0) {
          assignDailyMissions();
        }
      }

      function assignDailyMissions() {
        const availableMissions = state.missions.filter(m => !state.user.completedMissionsToday.includes(m.id));
        const shuffled = [...availableMissions].sort(()=>0.5 - Math.random());
        state.todayMissions = shuffled.slice(0,3);
        sSet('migstar_todayMissions', JSON.stringify(state.todayMissions));
      }

      function saveUser() { sSet('migstar_user', JSON.stringify(state.user)); }
      function saveTransactions() { sSet('migstar_transactions', JSON.stringify(state.transactions)); }
      function saveHistory() { sSet('migstar_history', JSON.stringify(state.history)); }
      function saveMissionPool() { sSet('migstar_missionPool', JSON.stringify(state.missions)); }

      function updateBalance(newBalance) {
        const balanceElement = elements.userBalance;
        const currentBalance = parseInt(balanceElement.textContent) || 0;
        const difference = newBalance - currentBalance;
        const step = difference / 10;
        let i = 0;
        const interval = setInterval(() => {
          if (i < 10) {
            const temp = Math.round(currentBalance + (step * i));
            balanceElement.textContent = temp;
            i++;
          } else {
            balanceElement.textContent = newBalance;
            clearInterval(interval);
          }
        }, 50);
      }

      function showToast(message, isSuccess = true) {
        const toast = elements.toast;
        toast.textContent = message;
        toast.className = `fixed bottom-4 right-4 px-6 py-3 rounded-lg shadow-lg toast ${isSuccess ? 'bg-green-500' : 'bg-red-500'} text-white`;
        toast.classList.remove('hidden');
        setTimeout(()=> toast.classList.add('hidden'), 3000);
      }

      function completeMission(missionId) {
        const mission = state.todayMissions.find(m=>m.id === missionId);
        if (!mission) return;
        if (state.user.completedMissionsToday.includes(missionId)) {
          showToast("Missão já completada hoje!", false);
          return;
        }
        state.user.stars += mission.reward;
        state.user.completedMissionsToday.push(missionId);
        saveUser();
        const historyItem = { type:'mission', title: mission.title, reward: mission.reward, date: new Date().toISOString() };
        state.history.unshift(historyItem);
        saveHistory();
        updateBalance(state.user.stars);
        showToast(`+${mission.reward} estrelas por "${mission.title}"!`);
        renderMissions();
        renderDashboard();
      }

      function receiveStars(amount) {
        amount = parseInt(amount);
        if (isNaN(amount) || amount <= 0) {
          showToast("Quantidade inválida!", false);
          return false;
        }
        state.user.stars += amount;
        saveUser();
        const transaction = { from: "Danilo Jorge", to: state.user.name, amount: amount, datetime: new Date().toISOString() };
        state.transactions.unshift(transaction);
        saveTransactions();
        const historyItem = { type: 'transaction', from: transaction.from, to: transaction.to, amount: transaction.amount, date: transaction.datetime };
        state.history.unshift(historyItem);
        saveHistory();
        updateBalance(state.user.stars);
        showToast(`Recebeu ${amount} estrelas de Danilo Jorge!`);
        renderDashboard();
        return true;
      }

      function renderUI() { renderDashboard(); renderMissions(); renderHistory('all'); }

      function renderDashboard(){
        elements.userBalance.textContent = state.user.stars;
        elements.userName.textContent = state.user.name;
        const completedCount = state.user.completedMissionsToday.length;
        const progress = (completedCount/3)*100;
        elements.missionProgress.style.width = `${progress}%`;
        elements.completedMissionsCount.textContent = completedCount;
        const lastTransaction = state.transactions[0];
        if (lastTransaction) {
          elements.lastTransaction.innerHTML = `<p>De: ${lastTransaction.from}</p><p>Valor: ${lastTransaction.amount} ${STAR_SYMBOL}</p><p class="text-sm">${new Date(lastTransaction.datetime).toLocaleString()}</p>`;
        } else elements.lastTransaction.innerHTML = 'Nenhuma transação ainda';
        const lastMission = state.history.find(item => item.type === 'mission');
        if (lastMission) {
          elements.lastMission.innerHTML = `<p>${lastMission.title}</p><p>Ganhou: ${lastMission.reward} ${STAR_SYMBOL}</p><p class="text-sm">${new Date(lastMission.date).toLocaleString()}</p>`;
        } else elements.lastMission.innerHTML = 'Nenhuma missão completada ainda';
      }

      function renderMissions(){
        const container = elements.missionsContainer;
        container.innerHTML = '';
        if (state.todayMissions.length === 0) {
          container.innerHTML = '<p class="text-blue-500">Nenhuma missão para hoje.</p>';
          return;
        }
        state.todayMissions.forEach(mission => {
          const isCompleted = state.user.completedMissionsToday.includes(mission.id);
          const missionElement = document.createElement('div');
          missionElement.className = `mission-card bg-white border-2 rounded-lg p-4 ${isCompleted ? 'mission-complete' : 'border-blue-100'}`;
          missionElement.innerHTML = `
            <div class="flex justify-between items-center">
              <div>
                <h3 class="font-medium ${isCompleted ? 'text-green-600' : 'text-blue-600'}">${mission.title}</h3>
                <p class="text-sm ${isCompleted ? 'text-green-500' : 'text-blue-500'}">Você pode ganhar: ${mission.reward} ${STAR_SYMBOL}</p>
              </div>
              <button class="mission-btn ${isCompleted ? 'bg-green-100 text-green-600' : 'bg-blue-100 text-blue-600'} rounded-full w-10 h-10 flex items-center justify-center" data-id="${mission.id}">
                ${isCompleted ? '✓' : '★'}
              </button>
            </div>`;
          container.appendChild(missionElement);
        });
        document.querySelectorAll('.mission-btn').forEach(btn=>{
          btn.addEventListener('click', (e)=>{
            const missionId = parseInt(e.currentTarget.getAttribute('data-id'));
            completeMission(missionId);
            if (!state.user.completedMissionsToday.includes(missionId)) {
              e.currentTarget.innerHTML = '<span class="star-animation">★</span>';
              setTimeout(()=> {
                e.currentTarget.innerHTML = '✓';
                e.currentTarget.className = 'mission-btn bg-green-100 text-green-600 rounded-full w-10 h-10 flex items-center justify-center';
              }, 500);
            }
          });
        });
      }

      function renderHistory(filter='all'){
        const container = elements.historyContainer;
        container.innerHTML = '';
        if (state.history.length === 0) { container.innerHTML = '<p class="text-blue-500">Nenhum histórico ainda.</p>'; return; }
        const filtered = filter === 'all' ? state.history : (filter === 'transactions' ? state.history.filter(i=>i.type==='transaction') : state.history.filter(i=>i.type==='mission'));
        filtered.forEach(item=>{
          const h = document.createElement('div');
          h.className = `p-3 rounded-lg ${item.type === 'transaction' ? 'transaction-item bg-blue-50' : 'mission-item bg-yellow-50'}`;
          if (item.type === 'transaction') {
            h.innerHTML = `<div class="flex justify-between"><div><p class="font-medium">De ${item.from}</p><p class="text-sm text-blue-500">${new Date(item.date).toLocaleString()}</p></div><div class="text-blue-600 font-bold">+${item.amount} ${STAR_SYMBOL}</div></div>`;
          } else {
            h.innerHTML = `<div class="flex justify-between"><div><p class="font-medium">${item.title}</p><p class="text-sm text-yellow-500">${new Date(item.date).toLocaleString()}</p></div><div class="text-yellow-600 font-bold">+${item.reward} ${STAR_SYMBOL}</div></div>`;
          }
          container.appendChild(h);
        });
      }

      function resetLocalStorage() {
        if (confirm("Tem certeza que deseja resetar todos os dados? Isso não pode ser desfeito.")) {
          sRemove('migstar_user'); sRemove('migstar_missionPool'); sRemove('migstar_transactions'); sRemove('migstar_history'); sRemove('migstar_todayMissions');
          location.reload();
        }
      }

function setupEventListeners() {

  // PEGAR ELEMENTOS
  elements.generateQRBtn = document.getElementById("generateQRBtn");
  elements.scanQRBtn = document.getElementById("scanQRBtn");
  elements.qrModal = document.getElementById("qrModal");
  elements.qrCodeArea = document.getElementById("qrCodeArea");
  elements.qrVideo = document.getElementById("qrVideo");
  elements.closeQR = document.getElementById("closeQR");

  let scanActive = false;
  let scanFrame;

  // ======================================================
  // === GERAR QR CODE — COMPACTADO EM BASE64 ============
  // ======================================================
  elements.generateQRBtn.addEventListener("click", () => {
    const amount = elements.amount.value;

    if (!amount || isNaN(amount) || amount <= 0) {
      showToast("Informe a quantidade!", false);
      return;
    }

    const payload = {
      type: "migstar_transfer",
      from: "Danilo Jorge",
      amount: parseInt(amount),
      device: navigator.userAgent,
      timestamp: Date.now()
    };

    const encoded = btoa(JSON.stringify(payload));

    elements.qrCodeArea.innerHTML = "";
    elements.qrVideo.classList.add("hidden");

    QRCode.toCanvas(
      encoded,
      { width: 260 },
      (err, canvas) => {
        if (!err) elements.qrCodeArea.appendChild(canvas);
      }
    );

    elements.qrModal.classList.remove("hidden");
  });

  // FECHAR O MODAL
  elements.closeQR.addEventListener("click", () => {
    elements.qrModal.classList.add("hidden");
    stopCamera();
  });

  function stopCamera() {
    scanActive = false;

    const stream = elements.qrVideo.srcObject;
    if (stream) stream.getTracks().forEach(t => t.stop());

    elements.qrVideo.srcObject = null;
    cancelAnimationFrame(scanFrame);
  }

  // ======================================================
  // === INICIAR LEITURA DO QR EM ALTA RESOLUÇÃO =========
  // ======================================================
  elements.scanQRBtn.addEventListener("click", startScanning);

function startScanning() {
    elements.qrCodeArea.innerHTML = "";
    elements.qrVideo.classList.remove("hidden");

    navigator.mediaDevices.getUserMedia({
        video: {
            facingMode: "environment",
            width: { ideal: 1280 },
            height: { ideal: 720 }
        }
    })
    .then(stream => {
        elements.qrVideo.srcObject = stream;

        elements.qrVideo.onloadedmetadata = () => {
            elements.qrVideo.play();
        };

        elements.qrVideo.onloadeddata = () => {
            scanActive = true;
            scanLoop();
        };

        elements.qrModal.classList.remove("hidden");
    })
    .catch(() => {
        showToast("Câmera não disponível!", false);
    });
}


  // ======================================================
  // === LOOP DE LEITURA — 60 FPS, ESPERA VÍDEO ===========
  // ======================================================
function scanLoop() {
    if (!scanActive) return;

    const video = elements.qrVideo;

    // AQUI está o pulo do gato:
    // o Android às vezes ativa a camera mas demora 200–500ms pra mandar o vídeo
    if (video.readyState < 2 || video.videoWidth === 0) {
        scanFrame = requestAnimationFrame(scanLoop);
        return;
    }

    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");

    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;

    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    const frame = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const qr = jsQR(frame.data, canvas.width, canvas.height);

    if (qr) {
        scanActive = false;
        stopCamera();

        try {
            const decoded = JSON.parse(atob(qr.data));
            handleQR(decoded);
        } catch (err) {
            showToast("QR inválido!", false);
        }

        return;
    }

    scanFrame = requestAnimationFrame(scanLoop);
}


  // ======================================================
  // === RESTO DAS FUNÇÕES ORIGINAIS ======================
  // ======================================================

  elements.tabButtons.forEach(btn => {
    btn.addEventListener('click', ()=> {
      elements.tabButtons.forEach(b=>{
        b.classList.remove('text-blue-600','border-blue-600');
        b.classList.add('text-blue-500','hover:text-blue-600');
      });

      btn.classList.add('text-blue-600','border-blue-600');
      btn.classList.remove('text-blue-500','hover:text-blue-600');

      const tabId = btn.getAttribute('data-tab');
      document.querySelectorAll('.tab-content').forEach(c=>c.classList.remove('active'));
      document.getElementById(tabId).classList.add('active');
    });
  });

  elements.receiveBtn.addEventListener('click', ()=>{
    const amount = elements.amount.value;
    if (!amount || isNaN(amount) || parseInt(amount) <= 0) {
      showToast("Digite uma quantidade válida!", false);
      return;
    }
    elements.passwordModal.classList.remove('hidden');
    elements.passwordInput.focus();
  });

  elements.confirmPassword.addEventListener('click', ()=> {
    const password = elements.passwordInput.value;
    if (password === "2009") {
      elements.passwordModal.classList.add('hidden');
      elements.passwordError.classList.add('hidden');
      const amount = elements.amount.value;
      if (receiveStars(amount)) elements.amount.value = '';
    } else {
      elements.passwordError.classList.remove('hidden');
    }
  });

  elements.cancelPassword.addEventListener('click', ()=>{
    elements.passwordModal.classList.add('hidden');
    elements.passwordError.classList.add('hidden');
  });

  elements.showAll.addEventListener('click', ()=> {
    elements.showAll.classList.add('text-blue-600','border-blue-600');
    elements.showAll.classList.remove('text-blue-500','hover:text-blue-600');
    elements.showTransactions.classList.remove('text-blue-600','border-blue-600');
    elements.showMissions.classList.remove('text-blue-600','border-blue-600');
    renderHistory('all');
  });

  elements.showTransactions.addEventListener('click', ()=> {
    elements.showTransactions.classList.add('text-blue-600','border-blue-600');
    elements.showTransactions.classList.remove('text-blue-500','hover:text-blue-600');
    elements.showAll.classList.remove('text-blue-600','border-blue-600');
    elements.showMissions.classList.remove('text-blue-600','border-blue-600');
    renderHistory('transactions');
  });

  elements.showMissions.addEventListener('click', ()=> {
    elements.showMissions.classList.add('text-blue-600','border-blue-600');
    elements.showMissions.classList.remove('text-blue-500','hover:text-blue-600');
    elements.showAll.classList.remove('text-blue-600','border-blue-600');
    elements.showTransactions.classList.remove('text-blue-600','border-blue-600');
    renderHistory('missions');
  });

  elements.resetBtn.addEventListener('click', resetLocalStorage);

}

      // Initialize app behavior
      loadState();
      checkNewDay();
      renderUI();
      setupEventListeners();
      feather.replace();

      // verifica a cada minuto se mudou o dia (mantém seu comportamento)
      setInterval(()=>{
        const currentDate = new Date().toISOString().split('T')[0];
        if (currentDate !== state.todayDate) {
          state.todayDate = currentDate;
          assignDailyMissions();
          state.user.lastAssignedDate = state.todayDate;
          state.user.completedMissionsToday = [];
          saveUser();
          renderUI();
          showToast("🎉 Novas missões do dia foram liberadas!");
        }
      }, 60000);
    } // initApp

    boot(); // start
  })();
