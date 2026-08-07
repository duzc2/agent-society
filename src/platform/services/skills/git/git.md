Git 导入技能模块。
负责从 Git 仓库克隆技能包并注册到技能索引，管理 Git 导入技能的启停、更新和删除。
主要文件：
- `git_skill_service.js`：Git 技能导入服务，提供克隆导入、拉取更新、启停、删除等操作。
- `git_skill_repository.js`：Git 技能文件夹仓库，管理 skills/git 下的目录和文件读写。
