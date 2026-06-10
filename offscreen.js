/**
 * Offscreen Document — PDF Generation
 * Connects to the service worker via a named port so PDF requests are
 * delivered on a dedicated channel, avoiding interference from content-script
 * listeners that would prematurely close a chrome.runtime.sendMessage channel.
 */

window.addEventListener('load', () => {
  const port = chrome.runtime.connect({ name: 'pdf-generator' });

  port.onMessage.addListener(async (msg) => {
    if (msg.type === 'GENERATE_PDF_PDFMAKE') {
      try {
        const base64 = await renderPdfWithPdfMake(msg.docDef);
        port.postMessage({ type: 'PDF_RESULT', ok: true, requestId: msg.requestId, base64 });
      } catch (err) {
        port.postMessage({ type: 'PDF_RESULT', ok: false, requestId: msg.requestId, error: err.message });
      }
    }
  });
});

const PDFMAKE_FONT_FILES = {
  normal: 'NotoSerif-Regular.ttf',
  bold: 'NotoSerif-Bold.ttf',
  italics: 'NotoSerif-Italic.ttf',
  bolditalics: 'NotoSerif-BoldItalic.ttf'
};

let pdfMakeFontsReady = null;

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunks = [];
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    chunks.push(String.fromCharCode.apply(null, chunk));
  }
  return btoa(chunks.join(''));
}

async function ensurePdfMakeFonts() {
  if (pdfMakeFontsReady) return pdfMakeFontsReady;

  pdfMakeFontsReady = (async () => {
    pdfMake.vfs = pdfMake.vfs || {};

    await Promise.all(Object.values(PDFMAKE_FONT_FILES).map(async (fileName) => {
      if (pdfMake.vfs[fileName]) return;
      const response = await fetch(chrome.runtime.getURL(`fonts/${fileName}`));
      if (!response.ok) throw new Error(`Khong tai duoc font ${fileName}.`);
      pdfMake.vfs[fileName] = arrayBufferToBase64(await response.arrayBuffer());
    }));

    pdfMake.fonts = {
      ...(pdfMake.fonts || {}),
      NotoSerif: PDFMAKE_FONT_FILES
    };
  })();

  return pdfMakeFontsReady;
}

function registerPdfMakeTableLayouts() {
  const invoiceTable = (verticalPadding, horizontalPadding) => ({
    hLineWidth: () => 0.55,
    vLineWidth: () => 0.55,
    hLineColor: () => '#000000',
    vLineColor: () => '#000000',
    paddingLeft: () => horizontalPadding,
    paddingRight: () => horizontalPadding,
    paddingTop: () => verticalPadding,
    paddingBottom: () => verticalPadding
  });

  pdfMake.tableLayouts = {
    ...(pdfMake.tableLayouts || {}),
    hdDashedField: {
      hLineWidth: (i) => (i === 1 ? 0.35 : 0),
      vLineWidth: () => 0,
      hLineColor: () => '#d9d9d9',
      hLineStyle: () => ({ dash: { length: 2, space: 2 } }),
      paddingLeft: () => 0,
      paddingRight: () => 0,
      paddingTop: () => 1.5,
      paddingBottom: () => 1.5
    },
    hdInvoiceTable: invoiceTable(5, 2),
    hdInvoiceTableCompact: invoiceTable(4, 2),
    hdSignatureBox: {
      hLineWidth: () => 1.2,
      vLineWidth: () => 1.2,
      hLineColor: () => '#23b709',
      vLineColor: () => '#23b709',
      paddingLeft: () => 0,
      paddingRight: () => 0,
      paddingTop: () => 0,
      paddingBottom: () => 0
    }
  };
}

async function renderPdfWithPdfMake(docDef) {
  await ensurePdfMakeFonts();
  registerPdfMakeTableLayouts();
  return new Promise((resolve, reject) => {
    try {
      pdfMake.createPdf(docDef).getBuffer((buffer) => {
        resolve(arrayBufferToBase64(buffer));
      });
    } catch (err) {
      reject(err);
    }
  });
}
