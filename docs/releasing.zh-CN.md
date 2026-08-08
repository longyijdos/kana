# 发版流程

Kana 使用 `package.json` 作为运行时版本号的唯一来源，使用 `CHANGELOG.md` 作为用户可见发布说明的唯一来源，并使用 `v<version>` Git tag 标记实际发布的 commit。正式发布应让这三者保持一致。

## 版本策略

Kana 在 `1.0.0` 之前采用以下约定：

- `0.MINOR.0`：新增用户可见功能，或改变 CLI、配置、协议、持久化及其他公开行为。`1.0.0` 前的 breaking change 也提升 MINOR。
- `0.MINOR.PATCH`：向后兼容的 bug 修复和性能修复，不包含新功能或 breaking change。
- `0.MINOR.PATCH-alpha.N`、`-beta.N` 或 `-rc.N`：需要公开验证但尚未准备作为正式版本的构建。
- `1.0.0` 之后遵循标准 Semantic Versioning：breaking change 提升 MAJOR，向后兼容功能提升 MINOR，向后兼容修复提升 PATCH。

提交继续使用 Conventional Commits。`feat:` 通常要求 MINOR，`fix:` 通常要求 PATCH；使用 `feat!:`、`fix!:` 或 `BREAKING CHANGE:` footer 明确标记不兼容变化。只有 `refactor:`、`test:`、`docs:` 或 `chore:` 的内部变更通常不需要单独发版。

`conventional-changelog` 只负责从提交历史生成发布说明，不负责决定版本号。版本选择仍应根据用户可见影响人工确认。

## 准备正式版本

在最新 `main` 上准备 release commit；开始前确认工作区干净并取得最新 tags：

```bash
git switch main
git pull --ff-only
git fetch --tags
```

然后按顺序执行：

1. 根据上一个 tag 之后的用户可见变化确定新版本。
2. 更新 `package.json` 中的 `version`。
3. 更新欢迎面板的 `Highlights`，保持正好三项，只保留本次发布最重要的用户可见变化。
4. 运行 `bun run changelog`。它会读取最新 SemVer tag 之后的 Conventional Commits，并把新版本段添加到 `CHANGELOG.md` 顶部。
5. 审阅新版本段：合并重复或实现层面的条目，补充 breaking changes、升级步骤和重要安全说明。不要删除旧版本段。
6. 如果发布改变了文档化行为，同步更新对应的中英文文档。
7. 运行 `bun run check`，并检查最终 diff。

不要在日常发版中使用 `bun run changelog --release-count 0`；该参数会重建并覆盖完整历史。仓库中已有的历史发布说明经过人工整理，应予保留。

## 提交、标记和推送

把版本号、Changelog、Highlights 和本次发布需要的文档放进同一个 release commit：

```bash
git add package.json CHANGELOG.md src/tui/components/chat-blocks/welcome-block.ts docs
git commit -m "chore: release v0.3.0"
git tag -a v0.3.0 -m "Release v0.3.0"
git push --atomic origin main v0.3.0
```

根据实际 diff 调整 `git add` 的文件。正式版本统一使用 annotated tag；tag 必须指向 release commit，且不要修改或重复使用已经发布的 tag。

## 发布自动化

推送 `v*` tag 后，Release workflow 会：

1. 校验 tag、`package.json` 版本和 `CHANGELOG.md` 版本段一致。
2. 运行格式、类型和测试检查。
3. 构建 macOS/Linux 的 arm64、x64 二进制及 SHA-256 文件。
4. 从对应 Changelog 版本段提取 GitHub Release 正文。
5. 创建 Release，或在重新运行时更新正文并覆盖上传资产。

需要重新发布同一 tag 的构建资产时，从 GitHub Actions 手动运行 Release workflow 并选择已有 tag。该操作不会改变版本号或 tag 指向，因此应只用于恢复失败或重新生成同一源码的资产。
