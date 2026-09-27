// Leitura de código de barras pela câmera do celular.
// Usa o BarcodeDetector do navegador (Chrome/Android) e, se não houver, a biblioteca ZXing
// servida pelo próprio sistema. Também aceita digitar o código ou usar um leitor USB no PC
// (o leitor USB "digita" o código e aperta Enter).
import { html, icon } from './lib.js';

const FORMATS = ['ean_13', 'ean_8', 'code_128', 'code_39', 'upc_a', 'upc_e', 'itf', 'qr_code'];

function loadZxing() {
  if (window.ZXing) return Promise.resolve(window.ZXing);
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = '/vendor/zxing.min.js';
    s.onload = () => resolve(window.ZXing);
    s.onerror = () => reject(new Error('Não foi possível carregar o leitor.'));
    document.head.appendChild(s);
  });
}

/** Abre a câmera e devolve o código lido (ou digitado), ou null se cancelar. */
export function scanBarcode({ title = 'Ler código de barras' } = {}) {
  const dlg = document.getElementById('dialog');
  dlg.innerHTML = String(html`
    <div class="dialog-body scanner">
      <h2>${title}</h2>
      <p class="muted small" data-msg style="margin-bottom:10px">Aponte a câmera para o código de barras da embalagem.</p>
      <video playsinline muted></video>
      <form data-manual style="margin-top:12px" class="input-group">
        <input class="input" name="code" inputmode="numeric" placeholder="ou digite o código" autocomplete="off">
        <button class="btn secondary" type="submit">OK</button>
      </form>
    </div>
    <div class="dialog-actions"><button class="btn secondary" data-close>${icon('back')} Cancelar</button></div>`);

  const video = dlg.querySelector('video');
  const msg = dlg.querySelector('[data-msg]');
  let stream = null;
  let stopped = false;
  let zxingReader = null;

  return new Promise((resolve) => {
    const finish = (code) => {
      if (stopped) return;
      stopped = true;
      if (stream) stream.getTracks().forEach((t) => t.stop());
      if (zxingReader) try { zxingReader.reset(); } catch { /* ok */ }
      dlg.close();
      resolve(code ? String(code).trim() : null);
    };
    dlg.querySelector('[data-close]').onclick = () => finish(null);
    dlg.oncancel = () => finish(null);
    dlg.querySelector('[data-manual]').onsubmit = (e) => {
      e.preventDefault();
      const v = e.target.elements.code.value.trim();
      if (v) finish(v);
    };
    dlg.showModal();

    const fail = (text) => {
      video.style.display = 'none';
      msg.textContent = text;
      const input = dlg.querySelector('input[name=code]');
      input.focus();
    };

    if (!window.isSecureContext || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      fail('A câmera só funciona com o sistema aberto em endereço seguro (https). Digite o código ou use um leitor USB.');
      return;
    }

    (async () => {
      try {
        if ('BarcodeDetector' in window) {
          const supported = await window.BarcodeDetector.getSupportedFormats().catch(() => FORMATS);
          const detector = new window.BarcodeDetector({ formats: FORMATS.filter((f) => supported.includes(f)) });
          stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
          video.srcObject = stream;
          await video.play();
          const tick = async () => {
            if (stopped) return;
            try {
              const found = await detector.detect(video);
              if (found.length) return finish(found[0].rawValue);
            } catch { /* quadro ainda não pronto */ }
            setTimeout(tick, 250);
          };
          tick();
        } else {
          const ZXing = await loadZxing();
          zxingReader = new ZXing.BrowserMultiFormatReader();
          const result = await zxingReader.decodeOnceFromVideoDevice(undefined, video);
          finish(result.getText());
        }
      } catch (err) {
        if (stopped) return;
        fail(err && err.name === 'NotAllowedError'
          ? 'Sem permissão para usar a câmera. Libere a câmera no navegador ou digite o código.'
          : 'Não foi possível abrir a câmera. Digite o código ou use um leitor USB.');
      }
    })();
  });
}
