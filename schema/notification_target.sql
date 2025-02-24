CREATE TABLE `notification_target` (
    `id`                            int NOT NULL AUTO_INCREMENT,
    `fid`                           int NOT NULL,
    `domain`                        varchar(255) NOT NULL,
    `endpoint`                      varchar(255) NOT NULL,
    `token`                         varchar(100) NOT NULL,
    `active`                        boolean DEFAULT TRUE,

    PRIMARY KEY (`id`),
    UNIQUE KEY `target_constraint` (`fid`, `domain`, `endpoint`)
);
