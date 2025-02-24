CREATE TABLE `app` (
    `id`                            int NOT NULL AUTO_INCREMENT,
    `domain`                        varchar(255) NOT NULL,
    `frame_json`                    text NOT NULL,
    `last_check_attempt`            datetime DEFAULT NOW(),
    `last_check_success`            datetime DEFAULT NOW(),

    PRIMARY KEY (`id`),
    UNIQUE KEY `app_domain` (`domain`)
);
