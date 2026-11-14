window.__ModuleLoader__.load({
  id: '@dsh-workbench/dsh-appshots',
  factory(require) {
    const { createElement: h, useEffect, useRef, useState } = require('react');

    function point(event) {
      const bounds = event.currentTarget.getBoundingClientRect();
      return [Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width)),
        Math.min(1, Math.max(0, (event.clientY - bounds.top) / bounds.height))];
    }

    const contribution = {
      package: '@dsh-workbench/dsh-appshots',
      descriptors: [{
        id: '@dsh-workbench/dsh-appshots#workbenchAppshots/capture',
        namespace: 'workbenchAppshots', method: 'capture', service: 'workbenchAppshots',
        invocation: { kind: 'direct' }, parameters: [], cancellation: { parameter: 'signal' },
        result: {
          mode: 'strict', typeSymbol: '@dsh-workbench/dsh-appshots#CaptureResult',
          jsonSchema: { type: ['string', 'null'] }, create: () => ({ parse: value => value }),
        },
      }],
    };

    function Appshot({ session, sessionId, stage, nativeCapture }) {
      const [open, setOpen] = useState(false);
      const [image, setImage] = useState(null);
      const [box, setBox] = useState(null);
      const [label, setLabel] = useState('');
      const [error, setError] = useState('');
      const [busy, setBusy] = useState(false);
      const dialog = useRef(null);
      const canvas = useRef(null);
      const picker = useRef(null);
      const start = useRef(null);
      const active = useRef(null);
      const browserCaptureAvailable = Boolean(navigator.mediaDevices?.getDisplayMedia);

      useEffect(() => () => active.current?.abort(), [sessionId, open]);

      useEffect(() => {
        if (open && dialog.current && !dialog.current.open) dialog.current.showModal();
      }, [open]);

      useEffect(() => {
        const target = canvas.current;
        if (!image || !target) return;
        const width = target.width;
        const height = target.height;
        const context = target.getContext('2d');
        context.drawImage(image, 0, 0, width, height);
        if (!box) return;
        const [a, b] = box;
        const x = Math.min(a[0], b[0]) * width;
        const y = Math.min(a[1], b[1]) * height;
        const w = Math.abs(a[0] - b[0]) * width;
        const heightBox = Math.abs(a[1] - b[1]) * height;
        const line = Math.max(3, width / 360);
        context.strokeStyle = '#111827';
        context.lineWidth = line * 2;
        context.strokeRect(x, y, w, heightBox);
        context.strokeStyle = '#ffce3a';
        context.lineWidth = line;
        context.strokeRect(x, y, w, heightBox);
        if (!label.trim()) return;
        const font = Math.max(15, Math.round(width / 72));
        context.font = '600 ' + font + 'px system-ui';
        const left = Math.min(x, width - font * 2);
        const top = Math.max(0, Math.min(y - font * 1.8, height - font * 1.8));
        const maxWidth = width - left - 12;
        context.fillStyle = '#111827';
        context.fillRect(left, top, Math.min(maxWidth, context.measureText(label).width) + 10, font * 1.65);
        context.fillStyle = '#ffce3a';
        context.fillText(label, left + 5, top + font * 1.2, maxWidth);
      }, [image, box, label]);

      function close() {
        active.current?.abort();
        active.current = null;
        start.current = null;
        setBusy(false);
        setOpen(false);
        setImage(null);
        setBox(null);
        setLabel('');
        setError('');
      }

      async function withCapture(action) {
        if (active.current) return;
        const controller = new AbortController();
        active.current = controller;
        setBusy(true);
        setError('');
        try {
          const bitmap = await action(controller.signal);
          if (!controller.signal.aborted) {
            if (bitmap) {
              setImage(bitmap);
              setBox(null);
            }
          } else bitmap?.close?.();
        } catch (failure) {
          if (!controller.signal.aborted) setError(failure.message || 'Could not open the capture.');
        } finally {
          if (active.current === controller) {
            active.current = null;
            setBusy(false);
          }
        }
      }

      async function capture(signal) {
        if (!navigator.mediaDevices?.getDisplayMedia) throw new Error('The capture picker is unavailable. Open an existing screenshot.');
        const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
        const video = document.createElement('video');
        video.muted = true;
        video.srcObject = stream;
        const stop = () => stream.getTracks().forEach(track => track.stop());
        try {
          if (signal.aborted) throw signal.reason;
          signal.addEventListener('abort', stop, { once: true });
          await video.play();
          if (typeof video.requestVideoFrameCallback === 'function') {
            await new Promise((resolve, reject) => {
              signal.throwIfAborted();
              const cancel = () => { video.cancelVideoFrameCallback(frame); reject(signal.reason); };
              const frame = video.requestVideoFrameCallback(() => {
                signal.removeEventListener('abort', cancel);
                resolve();
              });
              signal.addEventListener('abort', cancel, { once: true });
            });
          }
          if (!video.videoWidth) throw new Error('The selected source produced no image.');
          return await createImageBitmap(video);
        } finally {
          signal.removeEventListener('abort', stop);
          stop();
          video.srcObject = null;
        }
      }

      async function captureWindow(signal) {
        if (!nativeCapture) return capture(signal);
        const result = await nativeCapture(signal);
        signal.throwIfAborted();
        if (!result?.ok) throw new Error(result?.error?.message ?? 'Could not capture the window.');
        if (result.value === null) return null;
        const bytes = Uint8Array.fromBase64(result.value);
        return createImageBitmap(new Blob([bytes], { type: 'image/png' }));
      }

      async function attach() {
        if (!canvas.current || active.current) return;
        const controller = new AbortController();
        active.current = controller;
        setBusy(true);
        try {
          const blob = await new Promise(resolve => canvas.current.toBlob(resolve, 'image/png'));
          if (controller.signal.aborted) return;
          if (!blob) throw new Error('Could not create the PNG.');
          stage(sessionId, new File([blob], 'appshot.png', { type: 'image/png' }), session.subagent === null);
          close();
        } catch (failure) {
          if (!controller.signal.aborted) setError(failure.message);
        } finally {
          if (active.current === controller) {
            active.current = null;
            setBusy(false);
          }
        }
      }

      useEffect(() => () => image?.close?.(), [image]);

      const scale = image ? Math.min(1, 2400 / Math.max(image.width, image.height)) : 1;
      const scaledWidth = image ? Math.max(1, Math.round(image.width * scale)) : 1;
      const scaledHeight = image ? Math.max(1, Math.round(image.height * scale)) : 1;

      return h(ReactFragment, null,
        h('button', { type: 'button', className: 'dwas-trigger', onClick: () => setOpen(true) }, 'Appshot'),
        open && h('dialog', { ref: dialog, className: 'dwas-dialog', 'aria-label': 'Appshot', onCancel: event => { event.preventDefault(); close(); } },
          h('style', null, `
            .dwas-dialog{width:min(760px,calc(100vw - 36px));max-height:calc(100dvh - 36px);box-sizing:border-box;overflow:auto;padding:20px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary)}
            .dwas-dialog::backdrop{background:#0007}.dwas-dialog h2{margin:0 0 12px;font-size:18px}
            .dwas-tools{display:flex;align-items:center;flex-wrap:wrap;gap:8px;margin:10px 0}
            .dwas-dialog button,.dwas-dialog input:not([hidden]){font:inherit;color:inherit;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:7px;padding:7px 11px}
            .dwas-dialog button,.dwas-trigger{cursor:pointer}.dwas-trigger{margin:5px 8px;padding:5px 10px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2);border-radius:7px;font:inherit}
            .dwas-dialog canvas{display:block;max-width:100%;max-height:54vh;touch-action:none;cursor:crosshair;border-radius:6px}
            .dwas-dialog p{font-size:13px}.dwas-dialog [role=alert]{color:var(--dsw-alias-state-error-primary)}
          `),
          h('h2', null, 'Appshot'),
          h('div', { className: 'dwas-tools' },
            (nativeCapture || browserCaptureAvailable) && h('button', { type: 'button', disabled: busy, onClick: () => void withCapture(captureWindow) }, nativeCapture ? 'Capture window' : 'Capture window or tab'),
            h('button', { type: 'button', disabled: busy, onClick: () => picker.current.click() }, 'Open image'),
            h('input', { ref: picker, hidden: true, type: 'file', accept: 'image/png,image/jpeg,image/webp', onChange: event => {
              const file = event.target.files[0];
              event.target.value = '';
              if (file) void withCapture(() => {
                if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error('Choose a PNG, JPEG, or WebP image.');
                if (file.size > 15 * 1024 * 1024) throw new Error('Choose an image smaller than 15 MB.');
                return createImageBitmap(file);
              });
            } })),
          error && h('p', { role: 'alert' }, error),
          image && h(ReactFragment, null,
            h('p', null, 'Drag over the image to mark an area.'),
            h('canvas', { ref: canvas, width: scaledWidth, height: scaledHeight, 'aria-label': 'Screenshot preview',
              onPointerDown: event => {
                start.current = point(event);
                event.currentTarget.setPointerCapture(event.pointerId);
                setBox([start.current, start.current]);
              },
              onPointerMove: event => { if (start.current) setBox([start.current, point(event)]); },
              onPointerUp: () => { start.current = null; },
              onPointerCancel: () => { start.current = null; },
            }),
            h('div', { className: 'dwas-tools' },
              h('input', { 'aria-label': 'Annotation label', placeholder: 'Optional label', value: label, maxLength: 100, onChange: event => setLabel(event.target.value) }),
              h('button', { type: 'button', disabled: !box, onClick: () => { setBox(null); setLabel(''); } }, 'Clear mark'))),
          h('div', { className: 'dwas-tools' },
            h('button', { type: 'button', onClick: close }, 'Cancel'),
            h('button', { type: 'button', disabled: busy || !image, onClick: () => void attach() }, 'Attach to draft'))));
    }

    const ReactFragment = require('react').Fragment;
    return {
      inject: ['slots', 'conversation', 'remote'],
      async apply(ctx) {
        await ctx.get('remote').$mount(contribution);
        const conversation = ctx.get('conversation');
        ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
          name: 'conversation.input.dock', id: 'workbench-appshots', order: 35,
          inject: sessionId => ({
            sessionId,
            nativeCapture: location.protocol === 'dsh-app:' && document.documentElement.dataset.platform === 'darwin'
              ? signal => ctx.get('remote.workbenchAppshots').capture(signal)
              : undefined,
            stage(id, file, upload) {
              const shell = conversation.input.shell(id);
              const drafts = conversation.createDrafts(id, [file], upload);
              if (shell.addAttachments(drafts.map(draft => draft.id))) return;
              conversation.releaseDraftAttachments(drafts);
              throw new Error('The composer is busy. Try again when the current submission settles.');
            },
          }),
        }, Appshot));
      },
    };
  },
});
