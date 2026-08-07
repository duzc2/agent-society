/**
 * 附件管理器属性测试
 * 功能: chat-file-upload
 *
 * Property 8: Attachment Removal Decreases Count
 * Property 9: Send Clears All Attachments
 * Validates: Requirements 7.3, 7.5
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import * as fc from 'fast-check';

// 模拟 AttachmentManager 的核心逻辑（不依赖浏览器DOM的部分）
const AttachmentManagerLogic = {
  attachments: [],

  _generateId() {
    return `attachment_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  },

  reset() {
    this.attachments = [];
  },

  add(file, type) {
    const id = this._generateId();
    const attachment = {
      id,
      file,
      type,
      filename: file.name || `${type}_${Date.now()}`,
      size: file.size,
      status: 'pending',
      progress: 0,
      preview: null,
      artifactRef: null,
      error: null
    };
    this.attachments.push(attachment);
    return id;
  },

  remove(id) {
    const index = this.attachments.findIndex(a => a.id === id);
    if (index === -1) return false;
    this.attachments.splice(index, 1);
    return true;
  },

  clear() {
    this.attachments = [];
  },

  count() {
    return this.attachments.length;
  },

  hasAttachments() {
    return this.attachments.length > 0;
  },

  update(id, updates) {
    const attachment = this.attachments.find(a => a.id === id);
    if (attachment) {
      Object.assign(attachment, updates);
    }
  },

  setReady(id, artifactRef) {
    this.update(id, { status: 'ready', progress: 100, artifactRef });
  },

  allReady() {
    return this.attachments.length > 0 &&
           this.attachments.every(a => a.status === 'ready');
  },

  getArtifactRefs() {
    return this.attachments
      .filter(a => a.status === 'ready' && a.artifactRef)
      .map(a => ({
        type: a.type,
        artifactRef: a.artifactRef,
        filename: a.filename
      }));
  }
};

// 模拟文件对象生成器
const mockFileArb = fc.record({
  name: fc.string({ minLength: 1, maxLength: 50 }).map(s => s.replace(/[<>:"/\\|?*]/g, '_') + '.jpg'),
  size: fc.integer({ min: 1, max: 10000000 }),
  type: fc.oneof(fc.constant('image/jpeg'), fc.constant('application/pdf'))
});

const attachmentTypeArb = fc.oneof(fc.constant('image'), fc.constant('file'));

describe('功能: chat-file-upload, Property 8: Attachment Removal Decreases Count', () => {

  beforeEach(() => {
    AttachmentManagerLogic.reset();
  });

  it('移除一个附件应使数量减少1', () => {
    fc.assert(
      fc.property(
        fc.array(mockFileArb, { minLength: 1, maxLength: 10 }),
        attachmentTypeArb,
        (files, type) => {
          AttachmentManagerLogic.reset();

          // 添加所有文件
          const ids = files.map(file => AttachmentManagerLogic.add(file, type));
          const initialCount = AttachmentManagerLogic.count();

          assert.strictEqual(initialCount, files.length);

          // 移除第一个附件
          const removed = AttachmentManagerLogic.remove(ids[0]);
          assert.strictEqual(removed, true);

          // 验证数量减少1
          const newCount = AttachmentManagerLogic.count();
          assert.strictEqual(newCount, initialCount - 1);

          return true;
        }
      ),
      { numRuns: 100 }
    );
  });

  it('移除不存在的附件应返回false且数量不变', () => {
    fc.assert(
      fc.property(
        fc.array(mockFileArb, { minLength: 0, maxLength: 10 }),
        attachmentTypeArb,
        (files, type) => {
          AttachmentManagerLogic.reset();

          // 添加所有文件
          files.forEach(file => AttachmentManagerLogic.add(file, type));
          const initialCount = AttachmentManagerLogic.count();

          // 尝试移除不存在的ID
          const removed = AttachmentManagerLogic.remove('non_existent_id');
          assert.strictEqual(removed, false);

          // 验证数量不变
          assert.strictEqual(AttachmentManagerLogic.count(), initialCount);

          return true;
        }
      ),
      { numRuns: 100 }
    );
  });

  it('连续移除应正确减少数量', () => {
    fc.assert(
      fc.property(
        fc.array(mockFileArb, { minLength: 2, maxLength: 10 }),
        attachmentTypeArb,
        fc.integer({ min: 1, max: 5 }),
        (files, type, removeCount) => {
          AttachmentManagerLogic.reset();

          // 添加所有文件
          const ids = files.map(file => AttachmentManagerLogic.add(file, type));
          const initialCount = AttachmentManagerLogic.count();

          // 移除指定数量的附件（不超过总数）
          const actualRemoveCount = Math.min(removeCount, ids.length);
          for (let i = 0; i < actualRemoveCount; i++) {
            AttachmentManagerLogic.remove(ids[i]);
          }

          // 验证数量正确减少
          assert.strictEqual(AttachmentManagerLogic.count(), initialCount - actualRemoveCount);

          return true;
        }
      ),
      { numRuns: 100 }
    );
  });
});

describe('功能: chat-file-upload, Property 9: Send Clears All Attachments', () => {

  beforeEach(() => {
    AttachmentManagerLogic.reset();
  });

  it('clear() 应清空所有附件', () => {
    fc.assert(
      fc.property(
        fc.array(mockFileArb, { minLength: 1, maxLength: 20 }),
        attachmentTypeArb,
        (files, type) => {
          AttachmentManagerLogic.reset();

          // 添加所有文件
          files.forEach(file => AttachmentManagerLogic.add(file, type));
          assert.strictEqual(AttachmentManagerLogic.count(), files.length);
          assert.strictEqual(AttachmentManagerLogic.hasAttachments(), true);

          // 清空
          AttachmentManagerLogic.clear();

          // 验证已清空
          assert.strictEqual(AttachmentManagerLogic.count(), 0);
          assert.strictEqual(AttachmentManagerLogic.hasAttachments(), false);
          assert.deepStrictEqual(AttachmentManagerLogic.attachments, []);

          return true;
        }
      ),
      { numRuns: 100 }
    );
  });

  it('清空后 getArtifactRefs() 应返回空数组', () => {
    fc.assert(
      fc.property(
        fc.array(mockFileArb, { minLength: 1, maxLength: 10 }),
        fc.array(fc.uuid(), { minLength: 1, maxLength: 10 }),
        (files, artifactIds) => {
          AttachmentManagerLogic.reset();

          // 添加文件并设置为ready状态
          const ids = files.map(file => AttachmentManagerLogic.add(file, 'image'));
          ids.forEach((id, index) => {
            const artifactRef = `artifact:${artifactIds[index % artifactIds.length]}`;
            AttachmentManagerLogic.setReady(id, artifactRef);
          });

          // 验证有附件引用
          assert.ok(AttachmentManagerLogic.getArtifactRefs().length > 0);

          // 清空
          AttachmentManagerLogic.clear();

          // 验证附件引用为空
          assert.deepStrictEqual(AttachmentManagerLogic.getArtifactRefs(), []);

          return true;
        }
      ),
      { numRuns: 100 }
    );
  });

  it('空列表调用 clear() 应保持为空', () => {
    AttachmentManagerLogic.reset();
    assert.strictEqual(AttachmentManagerLogic.count(), 0);

    AttachmentManagerLogic.clear();

    assert.strictEqual(AttachmentManagerLogic.count(), 0);
    assert.strictEqual(AttachmentManagerLogic.hasAttachments(), false);
  });
});

describe('功能: chat-file-upload, 附件管理器状态测试', () => {

  beforeEach(() => {
    AttachmentManagerLogic.reset();
  });

  it('添加附件应增加数量', () => {
    fc.assert(
      fc.property(
        fc.array(mockFileArb, { minLength: 1, maxLength: 20 }),
        attachmentTypeArb,
        (files, type) => {
          AttachmentManagerLogic.reset();

          files.forEach((file, index) => {
            AttachmentManagerLogic.add(file, type);
            assert.strictEqual(AttachmentManagerLogic.count(), index + 1);
          });

          return true;
        }
      ),
      { numRuns: 100 }
    );
  });

  it('setReady 应正确更新状态和 artifactRef', () => {
    fc.assert(
      fc.property(
        mockFileArb,
        fc.uuid(),
        (file, artifactId) => {
          AttachmentManagerLogic.reset();

          const id = AttachmentManagerLogic.add(file, 'image');
          const artifactRef = `artifact:${artifactId}`;

          AttachmentManagerLogic.setReady(id, artifactRef);

          const refs = AttachmentManagerLogic.getArtifactRefs();
          assert.strictEqual(refs.length, 1);
          assert.strictEqual(refs[0].artifactRef, artifactRef);

          return true;
        }
      ),
      { numRuns: 100 }
    );
  });

  it('allReady 应正确判断所有附件状态', () => {
    fc.assert(
      fc.property(
        fc.array(mockFileArb, { minLength: 1, maxLength: 5 }),
        fc.array(fc.uuid(), { minLength: 5, maxLength: 10 }),
        (files, artifactIds) => {
          AttachmentManagerLogic.reset();

          // 添加文件
          const ids = files.map(file => AttachmentManagerLogic.add(file, 'image'));

          // 初始状态不是 allReady
          assert.strictEqual(AttachmentManagerLogic.allReady(), false);

          // 设置所有为 ready
          ids.forEach((id, index) => {
            AttachmentManagerLogic.setReady(id, `artifact:${artifactIds[index]}`);
          });

          // 现在应该是 allReady
          assert.strictEqual(AttachmentManagerLogic.allReady(), true);

          return true;
        }
      ),
      { numRuns: 100 }
    );
  });
});
