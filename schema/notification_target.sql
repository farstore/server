CREATE TABLE `notification_target` (
    `id`                            int NOT NULL AUTO_INCREMENT,
    `fid`                           int NOT NULL,
    `url`                           varchar(255) NOT NULL,
    `token`                         varchar(36) NOT NULL,
    `active`                        boolean DEFAULT TRUE,

    PRIMARY KEY (`id`),
    UNIQUE KEY `target_constraint` (`fid`,`url`)
);
