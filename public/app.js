function app() {
  return {
    form: { type: '', location: '', limit: 40, emails: true },
    presets: ['plumber', 'salon', 'dentist', 'cafe', 'electrician', 'gym', 'restaurant', 'lawyer'],
    suggestions: [],
    showSugg: false,
    results: [],
    pendingEmails: new Set(),
    error: '',
    running: false,
    es: null,
    statusLabel: 'idle',
    copied: {},
    copiedAll: false,
    filter: '',
    sortKey: 'rating',

    selected: new Set(),

    composeOpen: false,
    smtp: { host: '', port: 465, secure: true, user: '', pass: '' },
    showPass: false,
    rememberPass: false,
    smtpVerifying: false,
    smtpStatus: 'idle',
    smtpStatusLabel: 'untested',
    fromName: '',
    fromEmail: '',
    replyTo: '',
    subject: '',
    body: '',
    delayMs: 4500,
    testTo: '',
    quill: null,
    tokenList: ['name', 'first_name', 'phone', 'website', 'category', 'city', 'address', 'email'],
    sending: false,
    sendEs: null,
    sendStats: { sent: 0, failed: 0, skipped: 0, total: 0, feed: [] },

    init() {
      const saved = localStorage.getItem('gmap_form');
      if (saved) try { Object.assign(this.form, JSON.parse(saved)); } catch {}
      this.$watch('form', (v) => localStorage.setItem('gmap_form', JSON.stringify(v)), { deep: true });

      const smtpSaved = localStorage.getItem('gmap_smtp');
      if (smtpSaved) try {
        const s = JSON.parse(smtpSaved);
        Object.assign(this.smtp, s.smtp || {});
        if (s.smtp && s.smtp.pass) this.rememberPass = true;
        this.fromName = s.fromName || '';
        this.fromEmail = s.fromEmail || '';
        this.replyTo = s.replyTo || '';
      } catch {}
      this.$watch('smtp', () => this.persistSmtp(), { deep: true });
      this.$watch('rememberPass', () => this.persistSmtp());
      this.$watch('fromName', () => this.persistSmtp());
      this.$watch('fromEmail', () => this.persistSmtp());
      this.$watch('replyTo', () => this.persistSmtp());
    },

    persistSmtp() {
      const payload = {
        smtp: {
          host: this.smtp.host,
          port: this.smtp.port,
          secure: this.smtp.secure,
          user: this.smtp.user,
          pass: this.rememberPass ? this.smtp.pass : ''
        },
        fromName: this.fromName,
        fromEmail: this.fromEmail,
        replyTo: this.replyTo
      };
      try { localStorage.setItem('gmap_smtp', JSON.stringify(payload)); } catch {}
    },

    get emailHits() {
      return this.results.filter((r) => r.email).length;
    },

    get selectableCount() {
      return this.results.filter((r) => r.email).length;
    },

    get recipients() {
      return this.results.filter((r) => this.selected.has(r.id));
    },

    get estDuration() {
      const n = this.recipients.filter((r) => r.email).length;
      if (!n) return '0s';
      const sec = Math.round((n * this.delayMs) / 1000);
      if (sec < 60) return sec + 's';
      const m = Math.floor(sec / 60);
      const s = sec % 60;
      return `${m}m ${s}s`;
    },

    get filtered() {
      let arr = [...this.results];
      const q = this.filter.trim().toLowerCase();
      if (q) {
        arr = arr.filter((r) =>
          [r.name, r.category, r.address, r.email, r.phone, r.website]
            .filter(Boolean)
            .some((s) => String(s).toLowerCase().includes(q))
        );
      }
      const k = this.sortKey;
      if (k === 'rating') arr.sort((a, b) => (b.rating || 0) - (a.rating || 0));
      else if (k === 'reviews') arr.sort((a, b) => (b.reviews || 0) - (a.reviews || 0));
      else if (k === 'name') arr.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
      return arr;
    },

    toggleSelect(id) {
      const r = this.results.find((x) => x.id === id);
      if (!r || !r.email) return;
      if (this.selected.has(id)) this.selected.delete(id);
      else this.selected.add(id);
      this.selected = new Set(this.selected);
    },

    selectWithEmail() {
      for (const r of this.results) if (r.email) this.selected.add(r.id);
      this.selected = new Set(this.selected);
    },

    clearSelection() {
      this.selected = new Set();
    },

    async suggest() {
      const q = this.form.location.trim();
      if (q.length < 2) { this.suggestions = []; return; }
      try {
        const r = await fetch('/api/suggest?q=' + encodeURIComponent(q));
        const data = await r.json();
        this.suggestions = data.items || [];
        this.showSugg = true;
      } catch { this.suggestions = []; }
    },

    pickSuggestion(s) {
      this.form.location = s.short || s.label;
      this.showSugg = false;
    },

    start() {
      if (this.running) return;
      if (!this.form.type.trim() || !this.form.location.trim()) {
        this.error = 'Business type and location required';
        return;
      }
      this.error = '';
      this.results = [];
      this.pendingEmails = new Set();
      this.selected = new Set();
      this.running = true;
      this.statusLabel = 'connecting';

      const params = new URLSearchParams({
        type: this.form.type,
        location: this.form.location,
        limit: String(this.form.limit || 40),
        emails: this.form.emails ? '1' : '0'
      });

      const es = new EventSource('/api/scrape?' + params.toString());
      this.es = es;

      es.addEventListener('start', () => { this.statusLabel = 'scanning'; });

      es.addEventListener('result', (e) => {
        const rec = JSON.parse(e.data);
        this.results.push(rec);
        if (this.form.emails && rec.website) this.pendingEmails.add(rec.id);
      });

      es.addEventListener('email', (e) => {
        const data = JSON.parse(e.data);
        const r = this.results.find((x) => x.id === data.id);
        if (r) {
          r.email = data.email || '';
          r.emails = data.emails || [];
        }
        this.pendingEmails.delete(data.id);
      });

      es.addEventListener('contacts', (e) => {
        const data = JSON.parse(e.data);
        const r = this.results.find((x) => x.id === data.id);
        if (r) {
          r.email = data.email || '';
          r.emails = data.emails || [];
          r.whatsapp = data.whatsapp || [];
          r.whatsappConfirmed = !!data.whatsappConfirmed;
        }
        this.pendingEmails.delete(data.id);
      });

      es.addEventListener('error', (e) => {
        try { if (e.data) { const d = JSON.parse(e.data); this.error = d.message || 'stream error'; } } catch {}
        this.stop();
      });

      es.addEventListener('done', (e) => {
        const data = JSON.parse(e.data || '{}');
        this.statusLabel = 'done · ' + (data.count || this.results.length) + ' rows';
        this.stop(false);
      });

      es.onerror = () => {
        if (this.running) { this.statusLabel = 'connection lost'; this.stop(); }
      };
    },

    stop(setLabel = true) {
      if (this.es) { try { this.es.close(); } catch {} this.es = null; }
      this.running = false;
      if (setLabel) this.statusLabel = 'idle';
    },

    emailPending(r) { return this.pendingEmails.has(r.id); },

    ratingBar(r) {
      const filled = Math.round((r || 0));
      const max = 5;
      return '█'.repeat(filled) + '<span class="text-amber/20">' + '█'.repeat(max - filled) + '</span>';
    },

    prettyUrl(u) {
      try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; }
    },

    waUrl(r) {
      if (!r || !r.phone) return '';
      const digits = String(r.phone).replace(/[^\d]/g, '');
      if (digits.length < 7) return '';
      return 'https://wa.me/' + digits;
    },

    async copy(text, key) {
      if (!text) return;
      try {
        await navigator.clipboard.writeText(text);
        this.copied[key] = true;
        setTimeout(() => { this.copied[key] = false; }, 1400);
      } catch {}
    },

    async copyRow(r) {
      const lines = [r.name, r.category, r.phone, r.website, r.email, r.address, r.rating != null ? (r.rating + ' (' + (r.reviews || 0) + ')') : ''].filter(Boolean);
      await this.copy(lines.join(' · '), 'row_' + r.id);
    },

    async copyAll() {
      const tsv = this.filtered.map((r) => [r.name, r.phone, r.email, r.website, r.rating, r.reviews, r.address].map((v) => (v == null ? '' : String(v))).join('\t')).join('\n');
      try { await navigator.clipboard.writeText(tsv); this.copiedAll = true; setTimeout(() => { this.copiedAll = false; }, 1600); } catch {}
    },

    async exportFile(format) {
      if (!this.results.length) return;
      const res = await fetch('/api/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rows: this.filtered, format })
      });
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = format === 'json' ? 'businesses.json' : 'businesses.csv';
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    },

    clearAll() {
      this.results = [];
      this.pendingEmails = new Set();
      this.statusLabel = 'idle';
      this.error = '';
      this.selected = new Set();
    },

    openCompose() {
      if (!this.selected.size) {
        this.selectWithEmail();
      }
      this.composeOpen = true;
      this.$nextTick(() => this.mountQuill());
    },

    closeCompose() {
      this.composeOpen = false;
    },

    mountQuill() {
      if (this.quill) return;
      const el = document.getElementById('quill-editor');
      if (!el || typeof Quill === 'undefined') return;
      this.quill = new Quill(el, {
        theme: 'snow',
        placeholder: 'Write your message…',
        modules: {
          toolbar: {
            container: [
              [{ header: [1, 2, 3, false] }],
              ['bold', 'italic', 'underline', 'strike'],
              [{ color: [] }, { background: [] }],
              [{ list: 'ordered' }, { list: 'bullet' }],
              ['blockquote', 'code-block'],
              ['link', 'image'],
              [{ align: [] }],
              ['clean']
            ],
            handlers: {
              image: () => this.imagePicker()
            }
          }
        }
      });
      this.quill.on('text-change', () => {
        this.body = this.quill.root.innerHTML;
      });
    },

    imagePicker() {
      if (!this.quill) return;
      let savedIndex = null;
      try {
        const r = this.quill.getSelection();
        if (r && typeof r.index === 'number') savedIndex = r.index;
      } catch {}

      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*';
      input.style.display = 'none';
      document.body.appendChild(input);
      input.addEventListener('change', async () => {
        const file = input.files && input.files[0];
        if (!file) { input.remove(); return; }
        try {
          if (file.size > 5 * 1024 * 1024) {
            alert('Image too large (max 5MB)');
            return;
          }
          const fd = new FormData();
          fd.append('image', file);
          const res = await fetch('/api/email/upload-image', { method: 'POST', body: fd });
          let data = {};
          try { data = await res.json(); } catch {}
          if (!res.ok || !data.url) {
            alert('Upload failed: ' + (data.error || ('HTTP ' + res.status)));
            return;
          }
          this.insertImageAtCaret(data.url, savedIndex);
        } catch (e) {
          alert('Image upload error: ' + (e && e.message || e));
        } finally {
          input.remove();
        }
      }, { once: true });
      input.click();
    },

    insertImageAtCaret(url, preferredIndex) {
      if (!this.quill || !url) return;
      try {
        const Delta = Quill.import('delta');
        const length = this.quill.getLength();
        let index;
        if (typeof preferredIndex === 'number' && preferredIndex >= 0 && preferredIndex <= length) {
          index = preferredIndex;
        } else {
          index = Math.max(0, length - 1);
        }
        const delta = new Delta().retain(index).insert({ image: url });
        this.quill.updateContents(delta, 'silent');
        this.body = this.quill.root.innerHTML;
      } catch (e) {
        const safe = String(url).replace(/[<>"']/g, '');
        this.quill.root.insertAdjacentHTML('beforeend', '<p><img src="' + safe + '"></p>');
        this.body = this.quill.root.innerHTML;
      }
    },

    insertToken(token) {
      const piece = '{{' + token + '}}';
      if (this.quill) {
        const range = this.quill.getSelection(true);
        this.quill.insertText(range ? range.index : 0, piece, 'user');
      }
    },

    async verifySmtp() {
      this.smtpVerifying = true;
      this.smtpStatus = 'idle';
      this.smtpStatusLabel = 'testing…';
      try {
        const res = await fetch('/api/email/verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ smtp: this.smtp })
        });
        const data = await res.json();
        if (data.ok) {
          this.smtpStatus = 'ok';
          this.smtpStatusLabel = '● connection ok';
        } else {
          this.smtpStatus = 'fail';
          this.smtpStatusLabel = '✕ ' + (data.error || 'failed');
        }
      } catch (e) {
        this.smtpStatus = 'fail';
        this.smtpStatusLabel = '✕ network error';
      } finally {
        this.smtpVerifying = false;
      }
    },

    sendTest() {
      if (!this.testTo) return;
      this._send({ testTo: this.testTo });
    },

    sendAll() {
      const targets = this.recipients.filter((r) => r.email);
      if (!targets.length) return;
      const ok = window.confirm('Send to ' + targets.length + ' recipients? Estimated duration: ' + this.estDuration);
      if (!ok) return;
      this._send({ rows: targets });
    },

    _send({ rows, testTo }) {
      if (this.sending) return;
      if (!this.smtp.host || !this.smtp.user || !this.smtp.pass) {
        alert('Fill SMTP host, user, and password first.');
        return;
      }
      if (!this.subject.trim()) {
        alert('Subject required.');
        return;
      }
      if (!this.body || this.body === '<p><br></p>') {
        alert('Body is empty.');
        return;
      }

      this.sending = true;
      this.sendStats = { sent: 0, failed: 0, skipped: 0, total: 0, feed: [] };

      const payload = {
        smtp: this.smtp,
        from: { name: this.fromName, email: this.fromEmail || this.smtp.user },
        replyTo: this.replyTo,
        subject: this.subject,
        html: this.body,
        rows: rows || [],
        delayMs: this.delayMs,
        testTo: testTo || ''
      };

      fetch('/api/email/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      }).then((res) => this._readSendStream(res)).catch((e) => {
        this.sendStats.feed.push({ kind: 'failed', email: '', note: String(e) });
        this.sending = false;
      });
    },

    async _readSendStream(res) {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const chunk = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          this._handleSseChunk(chunk);
        }
      }
      this.sending = false;
    },

    _handleSseChunk(chunk) {
      let event = 'message';
      let data = '';
      for (const line of chunk.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data += line.slice(5).trim();
      }
      let payload = {};
      try { payload = JSON.parse(data); } catch {}

      if (event === 'start') {
        this.sendStats.total = payload.total || 0;
        this.sendStats.feed.push({ kind: 'start', email: '', note: payload.testMode ? 'test mode' : (payload.total + ' targets') });
      } else if (event === 'sent') {
        this.sendStats.sent++;
        this.sendStats.feed.push({ kind: 'sent', email: payload.email, note: '' });
      } else if (event === 'failed') {
        this.sendStats.failed++;
        this.sendStats.feed.push({ kind: 'failed', email: payload.email, note: payload.error || '' });
      } else if (event === 'skipped') {
        this.sendStats.skipped++;
        this.sendStats.feed.push({ kind: 'skipped', email: payload.email || '', note: payload.reason || '' });
      } else if (event === 'done') {
        this.sendStats.feed.push({ kind: 'done', email: '', note: 'log → ' + (payload.logFile || '') });
        this.sending = false;
      } else if (event === 'error') {
        this.sendStats.feed.push({ kind: 'failed', email: '', note: payload.message || 'stream error' });
        this.sending = false;
      }
    },

    stopSend() {
      this.sending = false;
    }
  };
}
