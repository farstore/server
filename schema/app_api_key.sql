CREATE TABLE `app_api_key` (
    `id`                            int NOT NULL AUTO_INCREMENT,
    `domain`                        varchar(255) NOT NULL,
    `api_key`                       varchar(100) NOT NULL,

    PRIMARY KEY (`id`)
);
