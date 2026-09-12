"""実Chromiumで曲・セットリストの復元と保存障害を検証する。外部通信なし。"""
import json
import threading
import unittest
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from playwright.sync_api import sync_playwright


class RestoreBrowserTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        class Quiet(SimpleHTTPRequestHandler):
            def log_message(self, *_): pass
        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), partial(Quiet, directory=str(Path(__file__).resolve().parents[1])))
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.playwright = sync_playwright().start()
        cls.browser = cls.playwright.chromium.launch()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close(); cls.playwright.stop(); cls.server.shutdown(); cls.server.server_close()

    def setUp(self):
        self.context = self.browser.new_context(service_workers='block')
        self.context.route('**/*', lambda route: route.continue_() if route.request.url.startswith('http://127.0.0.1:') else route.abort())
        self.page = self.context.new_page()
        self.page.goto(f'http://127.0.0.1:{self.server.server_port}')
        self.page.wait_for_function('typeof DB !== "undefined"')

    def tearDown(self): self.context.close()

    def restore(self, name):
        backup = {'app':'karaoke-repertoire','version':1,'songs':[{'id':name,'title':name,'artist':'テスト歌手'}], 'setlists':[{'name':name,'items':[{'id':name,'done':False}]}]}
        self.page.locator('#importFile').set_input_files({'name':name+'.json','mimeType':'application/json','buffer':json.dumps(backup).encode()})
        self.page.wait_for_function("document.querySelector('#toast').textContent.includes('件') || document.querySelector('#toast').textContent.includes('失敗')")

    def snapshot(self):
        return self.page.evaluate("async () => ({songs:await DB.getAll(),setlists:JSON.parse(localStorage.getItem('utalog-setlists')||'[]')})")

    def test_songs_and_setlists_restore_together_after_reload(self):
        self.restore('first')
        self.page.reload()
        data = self.snapshot()
        self.assertEqual(len(data['songs']),1)
        self.assertEqual(data['setlists'][0]['items'][0]['id'],data['songs'][0]['id'])

    def test_setlist_quota_failure_rolls_back_new_songs(self):
        self.restore('first'); before=self.snapshot()
        self.page.evaluate("""() => { document.querySelector('#toast').textContent=''; const original=Storage.prototype.setItem; Storage.prototype.setItem=function(key,value){if(key==='utalog-setlists')throw new DOMException('容量不足','QuotaExceededError'); return original.call(this,key,value);}; }""")
        self.restore('second')
        self.assertIn('失敗',self.page.locator('#toast').inner_text())
        self.assertEqual(self.snapshot(),before)

    def test_indexeddb_failure_does_not_add_dangling_setlist(self):
        self.restore('first'); before=self.snapshot()
        self.page.evaluate("""() => { document.querySelector('#toast').textContent=''; const original=IDBObjectStore.prototype.put; IDBObjectStore.prototype.put=function(...args){if(this.name==='songs')throw new DOMException('保存失敗','QuotaExceededError'); return original.apply(this,args);}; }""")
        self.restore('second')
        self.assertIn('失敗',self.page.locator('#toast').inner_text())
        self.assertEqual(self.snapshot(),before)


if __name__ == '__main__': unittest.main()
